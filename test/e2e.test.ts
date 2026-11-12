/**
 * End-to-end test: fake YNAB API + real MCP server over Streamable HTTP + MCP client.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PLAN = "11111111-1111-1111-1111-111111111111";
const cur = new Date().toISOString().slice(0, 7) + "-01";
const today = new Date().toISOString().slice(0, 10);
const cat = (id: string, gid: string, name: string, budgeted: number, activity: number, extra: object = {}) => ({
  id, category_group_id: gid, name, hidden: false, note: null, budgeted, activity, balance: budgeted + activity,
  goal_type: null, goal_target: null, goal_percentage_complete: null, goal_under_funded: null, goal_overall_left: null, deleted: false, ...extra,
});
const categories = [
  cat("c-rta", "g-int", "Inflow: Ready to Assign", 0, 0),
  cat("c-groc", "g-1", "Groceries", 400000, -450000, { goal_type: "NEED", goal_target: 500000, goal_under_funded: 100000, goal_percentage_complete: 80 }),
  cat("c-rest", "g-1", "Restaurants", 100000, -30000),
  cat("c-rent", "g-2", "Rent", 1000000, -1000000),
];
const tx = (id: string, amount: number, category_id: string | null, payee_id: string | null, extra: object = {}) => ({
  id, date: today, amount, memo: null, cleared: "cleared", approved: true, flag_color: null, account_id: "a-chk",
  payee_id, category_id, transfer_account_id: null, transfer_transaction_id: null, deleted: false, ...extra,
});
let requests: string[] = [];
let budgetedPatched: unknown = null;
const planExport = {
  id: PLAN, name: "Test Plan", first_month: "2025-01-01", last_month: cur,
  currency_format: { iso_code: "EUR", decimal_digits: 2, currency_symbol: "€" },
  accounts: [
    { id: "a-chk", name: "Checking", type: "checking", on_budget: true, closed: false, note: null, balance: 2500000, cleared_balance: 2500000, uncleared_balance: 0, transfer_payee_id: "p-tr-chk", deleted: false },
    { id: "a-cc", name: "Visa", type: "creditCard", on_budget: true, closed: false, note: null, balance: -300000, cleared_balance: -300000, uncleared_balance: 0, transfer_payee_id: "p-tr-cc", deleted: false },
  ],
  payees: [
    { id: "p-shop", name: "Supermarket", transfer_account_id: null, deleted: false },
    { id: "p-boss", name: "Employer", transfer_account_id: null, deleted: false },
    { id: "p-cafe", name: "Cafe Nero", transfer_account_id: null, deleted: false },
    { id: "p-tr-cc", name: "Transfer : Visa", transfer_account_id: "a-cc", deleted: false },
  ],
  category_groups: [
    { id: "g-int", name: "Internal Master Category", hidden: false, deleted: false },
    { id: "g-1", name: "Everyday", hidden: false, deleted: false },
    { id: "g-2", name: "Bills", hidden: false, deleted: false },
  ],
  categories,
  months: [{ month: cur, note: null, income: 3000000, budgeted: 1500000, activity: -1480000, to_be_budgeted: 200000, age_of_money: 25, deleted: false, categories }],
  transactions: [
    tx("t1", 3000000, "c-rta", "p-boss"),
    tx("t2", -450000, "c-groc", "p-shop"),
    tx("t3", -1030000, null, "p-shop"), // split: rent + restaurant
    tx("t4", -200000, null, "p-tr-cc", { transfer_account_id: "a-cc" }),
    tx("t5", -15000, null, "p-cafe", { approved: false }),
  ],
  subtransactions: [
    { id: "s1", transaction_id: "t3", amount: -1000000, memo: null, payee_id: null, category_id: "c-rent", transfer_account_id: null, deleted: false },
    { id: "s2", transaction_id: "t3", amount: -30000, memo: "lunch", payee_id: "p-cafe", category_id: "c-rest", transfer_account_id: null, deleted: false },
  ],
  scheduled_transactions: [
    { id: "st1", date_first: "2025-01-01", date_next: today, frequency: "monthly", amount: -1000000, memo: null, flag_color: null, account_id: "a-chk", payee_id: null, category_id: "c-rent", transfer_account_id: null, deleted: false },
  ],
  scheduled_subtransactions: [],
};

let mock: http.Server;
let proc: ChildProcess;
let client: Client;
const PORT = 3999;

before(async () => {
  mock = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, "Bearer fake-ynab");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      res.setHeader("Content-Type", "application/json");
      if (u.pathname === `/v1/plans/${PLAN}` || u.pathname === "/v1/plans/last-used") {
        const delta = u.searchParams.get("last_knowledge_of_server");
        const data = delta
          ? { plan: { id: PLAN, name: "Test Plan", transactions: [{ ...planExport.transactions[4], deleted: true }] }, server_knowledge: 11 }
          : { plan: planExport, server_knowledge: 10 };
        return res.end(JSON.stringify({ data }));
      }
      if (u.pathname === "/v1/plans") return res.end(JSON.stringify({ data: { plans: [{ id: PLAN, name: "Test Plan", currency_format: { iso_code: "EUR" } }], default_plan: null } }));
      if (u.pathname.endsWith("/money_movements")) return res.end(JSON.stringify({ data: { money_movements: [{ id: "m1", moved_at: today, from_category_id: null, to_category_id: "c-groc", amount: 50000, note: null }] } }));
      if (req.method === "PATCH" && u.pathname.includes("/months/")) {
        budgetedPatched = JSON.parse(body);
        return res.end(JSON.stringify({ data: { category: cat("c-groc", "g-1", "Groceries", 600000, -450000) } }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { id: "404", name: "not_found", detail: "Resource not found" } }));
    });
  });
  await new Promise<void>((r) => mock.listen(3998, r));
  proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), YNAB_ACCESS_TOKEN: "fake-ynab", YNAB_API_BASE_URL: "http://127.0.0.1:3998/v1", MCP_AUTH_TOKEN: "secret123", YNAB_ALLOW_WRITES: "true", HTTPS_PROXY: "", HTTP_PROXY: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => proc.stdout!.on("data", (d) => String(d).includes("listening") && resolve()));
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/secret123`)));
});

after(async () => {
  await client?.close();
  proc?.kill();
  mock?.closeAllConnections();
  mock?.close();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
};

test("rejects requests without auth", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(res.status, 401);
  const bad = await fetch(`http://127.0.0.1:${PORT}/mcp/wrong`, { method: "POST", body: "{}" });
  assert.equal(bad.status, 401);
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(health.status, 200);
});

test("lists tools incl. write tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["get_budget_overview", "spending_report", "search_transactions", "create_transaction", "set_category_assigned"]) assert.ok(names.includes(n), n);
});

test("overview", async () => {
  const o = await call("get_budget_overview");
  assert.equal(o.ready_to_assign, 200);
  assert.equal(o.accounts.net_worth, 2200);
  assert.equal(o.overspent.count, 1);
  assert.equal(o.overspent.categories[0].category, "Groceries");
  assert.equal(o.underfunded_goals.total_needed, 100);
  assert.equal(o.unapproved_transactions, 1);
  assert.equal(o.uncategorized_transactions, 1); // t5 has no category, not a transfer
  assert.equal(requests.filter((r) => r.startsWith("GET /v1/plans/last-used")).length, 1);
});

test("spending report expands splits and excludes transfers/income", async () => {
  const r = await call("spending_report", { month: "current" });
  assert.equal(r.totals.income, 3000);
  assert.equal(r.totals.spending, 1480); // 450 + 1000 + 30
  assert.equal(r.totals.uncategorized, -15);
  assert.equal(r.groups[0].category, "Bills / Rent");
  const g = await call("spending_report", { month: "current", group_by: "group" });
  assert.deepEqual(g.groups.map((x: any) => [x.group, x.total]), [["Bills", 1000], ["Everyday", 480]]);
});

test("search transactions", async () => {
  const r = await call("search_transactions", { category: "rest" });
  assert.equal(r.count, 1);
  assert.equal(r.transactions[0].memo, "lunch");
  assert.equal(r.transactions[0].split_part, true);
  const u = await call("search_transactions", { status: ["unapproved"] });
  assert.equal(u.count, 1);
  const big = await call("search_transactions", { sort: "largest", limit: 1, exclude_transfers: true });
  assert.equal(big.transactions[0].amount, 3000);
});

test("categories, history, accounts, payees, scheduled, months, movements", async () => {
  const c = await call("get_categories", { group: "Everyday" });
  assert.equal(c.groups.length, 1);
  assert.equal(c.groups[0].categories[0].goal.underfunded_this_month, 100);
  const h = await call("get_category_history", { category: "Groceries", from_month: cur.slice(0, 7) });
  assert.equal(h.months[0].activity, -450);
  const a = await call("get_accounts");
  assert.equal(a.accounts.length, 2);
  const p = await call("get_payees", { search: "cafe" });
  assert.equal(p.payees[0].transactions, 2);
  const s = await call("get_scheduled_transactions");
  assert.equal(s.estimated_monthly_recurring_outflow, -1000);
  const m = await call("get_month_summaries");
  assert.equal(m.months.at(-1).savings_rate_pct, 50.7);
  const mm = await call("get_money_movements");
  assert.equal(mm.movements[0].from, "Ready to Assign");
  const pl = await call("list_plans");
  assert.equal(pl.plans[0].currency, "EUR");
});

test("delta sync removes deleted transaction", async () => {
  const s = await call("sync_status", { refresh: true });
  assert.equal(s.server_knowledge, 11);
  assert.equal(s.counts.transactions, 4);
  assert.ok(requests.some((r) => r.includes("last_knowledge_of_server=10")));
});

test("write: set category assigned", async () => {
  const r = await call("set_category_assigned", { category: "Groceries", amount: 600 });
  assert.deepEqual(budgetedPatched, { category: { budgeted: 600000 } });
  assert.equal(r.category.assigned, 600);
});

test("errors become tool errors", async () => {
  const r: any = await client.callTool({ name: "get_category_history", arguments: { category: "nope" } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /No category matches/);
});
