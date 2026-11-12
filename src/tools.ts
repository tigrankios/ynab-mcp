import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { YnabError, type Category, type PlanCache, type YnabService } from "./ynab.js";
import {
  addDays,
  addMonths,
  buildLines,
  classifyLine,
  fromMilli,
  isInternalGroup,
  json,
  monthEnd,
  normalizeMonth,
  resolveMany,
  resolveOne,
  round,
  todayIso,
  toMilli,
  validateDate,
  type Line,
} from "./util.js";

export const SERVER_INSTRUCTIONS = `YNAB (You Need A Budget) budget data.
- All money values are in the plan's currency units (e.g. 12.5 = 12.50). Negative transaction amounts are outflows, positive are inflows.
- "plan" = budget. plan_id is optional everywhere; the default plan is used when omitted. Call list_plans to see others.
- Months are YYYY-MM (or "current"/"previous"). Dates are YYYY-MM-DD.
- Accounts, categories and payees can be referenced by id or by (partial, case-insensitive) name.
- Data is cached and delta-synced; call sync_status with refresh=true if the user just changed something in YNAB.
- Start broad analysis with get_budget_overview, then drill down with spending_report, get_category_history and search_transactions.
- In YNAB a category's "available" is what is left to spend; negative available means overspent. "Ready to Assign" is unallocated money.`;

const planIdParam = z
  .string()
  .optional()
  .describe('Plan (budget) id. Omit for the default plan. "last-used" is also accepted.');

const READ = { readOnlyHint: true, openWorldHint: true } as const;

const FREQ_PER_MONTH: Record<string, number> = {
  never: 0,
  daily: 30.44,
  weekly: 4.345,
  everyOtherWeek: 2.1725,
  twiceAMonth: 2,
  every4Weeks: 1.0863,
  monthly: 1,
  everyOtherMonth: 1 / 2,
  every3Months: 1 / 3,
  every4Months: 1 / 4,
  twiceAYear: 1 / 6,
  yearly: 1 / 12,
  everyOtherYear: 1 / 24,
};

function errorResult(e: unknown) {
  let msg: string;
  if (e instanceof YnabError) {
    msg = e.message;
    if (e.status === 401) msg += " — the YNAB access token is invalid or revoked.";
    if (e.status === 429) msg += " — YNAB rate limit (200 requests/hour) reached; try again later.";
    if (e.status === 404) msg += " — check the plan/entity id (list_plans shows valid plan ids).";
  } else {
    msg = (e as Error)?.message ?? String(e);
  }
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/** Wraps a handler so thrown errors become MCP tool errors instead of protocol errors. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof json>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return errorResult(e);
    }
  };
}

function categoryView(c: Category) {
  const goal = c.goal_type
    ? {
        type: c.goal_type,
        target: fromMilli(c.goal_target),
        target_date: c.goal_target_date ?? c.goal_target_month ?? null,
        percent_complete: c.goal_percentage_complete,
        underfunded_this_month: fromMilli(c.goal_under_funded),
        overall_left: fromMilli(c.goal_overall_left),
        snoozed: !!c.goal_snoozed_at,
      }
    : undefined;
  return {
    id: c.id,
    name: c.name,
    assigned: fromMilli(c.budgeted),
    activity: fromMilli(c.activity),
    available: fromMilli(c.balance),
    ...(c.hidden ? { hidden: true } : {}),
    ...(c.note ? { note: c.note } : {}),
    ...(goal ? { goal } : {}),
  };
}

function lineView(l: Line) {
  return {
    id: l.transaction_id,
    ...(l.is_split_part ? { split_part: true } : {}),
    date: l.date,
    amount: fromMilli(l.amount),
    account: l.account,
    payee: l.payee,
    category: l.category,
    ...(l.category_group ? { group: l.category_group } : {}),
    ...(l.memo ? { memo: l.memo } : {}),
    cleared: l.cleared,
    ...(l.approved ? {} : { approved: false }),
    ...(l.flag ? { flag: l.flag } : {}),
    ...(l.transfer_account_id ? { transfer: true } : {}),
  };
}

function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  for (let m = fromMonth; m <= toMonth && out.length < 600; m = addMonths(m, 1)) out.push(m);
  return out;
}

function resolvePeriod(args: { since_date?: string; until_date?: string; month?: string }) {
  if (args.month) {
    const m = normalizeMonth(args.month);
    return { since: m, until: monthEnd(m) };
  }
  return {
    since: validateDate(args.since_date, "since_date"),
    until: validateDate(args.until_date, "until_date"),
  };
}

export function registerTools(server: McpServer, ynab: YnabService, config: Config) {
  const syncInfo = (p: PlanCache) => ({
    plan: p.name,
    currency: p.currency?.iso_code,
    synced_at: new Date(p.syncedAt).toISOString(),
  });

  // ------------------------------------------------------------------ plans
  server.registerTool(
    "list_plans",
    {
      title: "List plans (budgets)",
      description: "Lists the user's YNAB plans (budgets) with id, name, currency and date range.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const data = await ynab.client.request<{ plans: any[]; default_plan: any }>("GET", "/plans");
      return json({
        default_plan_id: data.default_plan?.id ?? null,
        server_default: config.defaultPlanId,
        plans: data.plans.map((p) => ({
          id: p.id,
          name: p.name,
          currency: p.currency_format?.iso_code,
          first_month: p.first_month,
          last_month: p.last_month,
          last_modified_on: p.last_modified_on,
        })),
      });
    }),
  );

  // --------------------------------------------------------------- overview
  server.registerTool(
    "get_budget_overview",
    {
      title: "Budget overview",
      description:
        "High-level health check of a plan for a month: Ready to Assign, income/assigned/activity, age of money, " +
        "net worth and account totals, overspent categories, underfunded goals, and counts of unapproved/uncategorized transactions. " +
        "Best first call for any budget analysis.",
      inputSchema: {
        plan_id: planIdParam,
        month: z.string().optional().describe('Month YYYY-MM, "current" (default) or "previous".'),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, month }) => {
      const p = await ynab.getPlan(plan_id);
      const m = normalizeMonth(month);
      const ms = p.months.get(m);

      const accounts = [...p.accounts.values()].filter((a) => !a.closed);
      const sum = (f: (a: (typeof accounts)[number]) => boolean) =>
        fromMilli(accounts.filter(f).reduce((s, a) => s + a.balance, 0));

      const cats = ms ? [...ms.categories.values()] : [...p.categories.values()];
      const visible = cats.filter((c) => {
        const g = p.categoryGroups.get(c.category_group_id);
        return !c.hidden && !isInternalGroup(g?.name);
      });
      const overspent = visible
        .filter((c) => c.balance < 0)
        .sort((a, b) => a.balance - b.balance)
        .map((c) => ({ category: c.name, available: fromMilli(c.balance) }));
      const underfunded = visible
        .filter((c) => (c.goal_under_funded ?? 0) > 0 && !c.goal_snoozed_at)
        .sort((a, b) => (b.goal_under_funded ?? 0) - (a.goal_under_funded ?? 0))
        .map((c) => ({ category: c.name, needed: fromMilli(c.goal_under_funded) }));

      const lines = buildLines(p);
      const parents = [...p.transactions.values()];
      const unapproved = parents.filter((t) => !t.approved).length;
      const uncategorized = lines.filter((l) => classifyLine(l, p) === "uncategorized").length;
      const importErrors = accounts.filter((a) => a.direct_import_in_error).map((a) => a.name);

      return json({
        ...syncInfo(p),
        month: m.slice(0, 7),
        month_found: !!ms,
        ready_to_assign: fromMilli(ms?.to_be_budgeted),
        income: fromMilli(ms?.income),
        assigned: fromMilli(ms?.budgeted),
        activity: fromMilli(ms?.activity),
        age_of_money_days: ms?.age_of_money ?? null,
        accounts: {
          net_worth: sum(() => true),
          on_budget_total: sum((a) => a.on_budget),
          cash_and_checking: sum((a) => ["checking", "savings", "cash"].includes(a.type)),
          credit_card_debt: sum((a) => a.type === "creditCard"),
          loans_and_liabilities: sum((a) =>
            ["otherLiability", "mortgage", "autoLoan", "studentLoan", "personalLoan", "medicalDebt", "otherDebt", "lineOfCredit"].includes(a.type),
          ),
          tracking_assets: sum((a) => !a.on_budget && a.balance > 0),
          open_accounts: accounts.length,
          direct_import_errors: importErrors,
        },
        overspent: { count: overspent.length, total: round(overspent.reduce((s, x) => s + (x.available ?? 0), 0)), categories: overspent.slice(0, 20) },
        underfunded_goals: {
          count: underfunded.length,
          total_needed: round(underfunded.reduce((s, x) => s + (x.needed ?? 0), 0)),
          categories: underfunded.slice(0, 20),
        },
        unapproved_transactions: unapproved,
        uncategorized_transactions: uncategorized,
        scheduled_transactions: p.scheduled.size,
      });
    }),
  );

  // --------------------------------------------------------------- accounts
  server.registerTool(
    "get_accounts",
    {
      title: "Accounts",
      description: "Lists accounts with balances (total/cleared/uncleared), type, on-budget flag and last reconciliation date.",
      inputSchema: {
        plan_id: planIdParam,
        include_closed: z.boolean().optional().describe("Include closed accounts (default false)."),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, include_closed }) => {
      const p = await ynab.getPlan(plan_id);
      const accounts = [...p.accounts.values()]
        .filter((a) => include_closed || !a.closed)
        .sort((a, b) => Number(b.on_budget) - Number(a.on_budget) || a.name.localeCompare(b.name))
        .map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          on_budget: a.on_budget,
          ...(a.closed ? { closed: true } : {}),
          balance: fromMilli(a.balance),
          cleared: fromMilli(a.cleared_balance),
          uncleared: fromMilli(a.uncleared_balance),
          last_reconciled_at: a.last_reconciled_at ?? null,
          ...(a.direct_import_linked ? { linked: true } : {}),
          ...(a.direct_import_in_error ? { import_error: true } : {}),
          ...(a.note ? { note: a.note } : {}),
        }));
      return json({ ...syncInfo(p), accounts });
    }),
  );

  // ------------------------------------------------------------- categories
  server.registerTool(
    "get_categories",
    {
      title: "Categories for a month",
      description:
        "Category groups and categories for a month with assigned, activity (spending, negative = spent), available, and goal/target progress.",
      inputSchema: {
        plan_id: planIdParam,
        month: z.string().optional().describe('Month YYYY-MM, "current" (default) or "previous".'),
        group: z.string().optional().describe("Only this category group (id or name)."),
        include_hidden: z.boolean().optional().describe("Include hidden categories (default false)."),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, month, group, include_hidden }) => {
      const p = await ynab.getPlan(plan_id);
      const m = normalizeMonth(month);
      const ms = p.months.get(m);
      const source = ms ? ms.categories : p.categories;
      const groups = [...p.categoryGroups.values()].filter((g) => !isInternalGroup(g.name) && (include_hidden || !g.hidden));
      const selected = group ? [resolveOne(groups, group, "category group")] : groups;
      const out = selected.map((g) => {
        const cats = [...source.values()]
          .filter((c) => c.category_group_id === g.id && (include_hidden || !c.hidden))
          .map(categoryView);
        return {
          group: g.name,
          group_id: g.id,
          assigned: round(cats.reduce((s, c) => s + (c.assigned ?? 0), 0)),
          activity: round(cats.reduce((s, c) => s + (c.activity ?? 0), 0)),
          available: round(cats.reduce((s, c) => s + (c.available ?? 0), 0)),
          categories: cats,
        };
      });
      return json({
        ...syncInfo(p),
        month: m.slice(0, 7),
        month_found: !!ms,
        ready_to_assign: fromMilli(ms?.to_be_budgeted),
        groups: out.filter((g) => g.categories.length),
      });
    }),
  );

  // ----------------------------------------------------------------- months
  server.registerTool(
    "get_month_summaries",
    {
      title: "Monthly summaries",
      description:
        "Month-by-month totals: income, assigned, activity (spending), Ready to Assign, age of money, and savings rate. " +
        "Good for trends over time.",
      inputSchema: {
        plan_id: planIdParam,
        from_month: z.string().optional().describe("First month YYYY-MM (default: 12 months ago)."),
        to_month: z.string().optional().describe('Last month YYYY-MM (default: "current").'),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, from_month, to_month }) => {
      const p = await ynab.getPlan(plan_id);
      const to = normalizeMonth(to_month);
      const from = from_month ? normalizeMonth(from_month) : addMonths(to, -11);
      const rows = [...p.months.values()]
        .filter((m) => m.month >= from && m.month <= to)
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => ({
          month: m.month.slice(0, 7),
          income: fromMilli(m.income),
          assigned: fromMilli(m.budgeted),
          activity: fromMilli(m.activity),
          net: fromMilli(m.income + m.activity),
          savings_rate_pct: m.income > 0 ? round(((m.income + m.activity) / m.income) * 100, 1) : null,
          ready_to_assign: fromMilli(m.to_be_budgeted),
          age_of_money: m.age_of_money,
          ...(m.note ? { note: m.note } : {}),
        }));
      const n = rows.length || 1;
      return json({
        ...syncInfo(p),
        months: rows,
        averages: {
          income: round(rows.reduce((s, r) => s + (r.income ?? 0), 0) / n),
          activity: round(rows.reduce((s, r) => s + (r.activity ?? 0), 0) / n),
          net: round(rows.reduce((s, r) => s + (r.net ?? 0), 0) / n),
        },
      });
    }),
  );

  // ------------------------------------------------------ category history
  server.registerTool(
    "get_category_history",
    {
      title: "Category history",
      description:
        "Per-month assigned / activity / available for one or more categories (or a whole category group) over a range of months. " +
        "Use it to spot trends, chronic overspending or over-assigning.",
      inputSchema: {
        plan_id: planIdParam,
        category: z.string().optional().describe("Category id or name (partial names match all matching categories)."),
        group: z.string().optional().describe("Category group id or name — sums all categories in the group."),
        from_month: z.string().optional().describe("First month YYYY-MM (default: 11 months before to_month)."),
        to_month: z.string().optional().describe('Last month YYYY-MM (default "current").'),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, category, group, from_month, to_month }) => {
      if (!category && !group) throw new Error("Pass category or group.");
      const p = await ynab.getPlan(plan_id);
      const to = normalizeMonth(to_month);
      const from = from_month ? normalizeMonth(from_month) : addMonths(to, -11);
      let ids: string[];
      let label: string;
      if (group) {
        const g = resolveOne(p.categoryGroups.values(), group, "category group");
        ids = [...p.categories.values()].filter((c) => c.category_group_id === g.id).map((c) => c.id);
        label = g.name;
      } else {
        const cs = resolveMany(p.categories.values(), category!, "category");
        if (cs.length > 10) throw new Error(`"${category}" matches ${cs.length} categories; be more specific.`);
        ids = cs.map((c) => c.id);
        label = cs.map((c) => c.name).join(", ");
      }
      const rows = monthsBetween(from, to).map((month) => {
        const ms = p.months.get(month);
        let b = 0, a = 0, bal = 0;
        for (const id of ids) {
          const c = ms?.categories.get(id);
          if (c) {
            b += c.budgeted;
            a += c.activity;
            bal += c.balance;
          }
        }
        return { month: month.slice(0, 7), assigned: fromMilli(b), activity: fromMilli(a), available: fromMilli(bal) };
      });
      const n = rows.length || 1;
      const spent = rows.map((r) => -(r.activity ?? 0));
      return json({
        ...syncInfo(p),
        categories: label,
        months: rows,
        stats: {
          avg_monthly_spending: round(spent.reduce((s, x) => s + x, 0) / n),
          max_monthly_spending: round(Math.max(...spent)),
          min_monthly_spending: round(Math.min(...spent)),
          avg_assigned: round(rows.reduce((s, r) => s + (r.assigned ?? 0), 0) / n),
          months_overspent: rows.filter((r) => (r.available ?? 0) < 0).length,
        },
      });
    }),
  );

  // ----------------------------------------------------------- transactions
  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Finds transactions with flexible filters. Split transactions are expanded into their parts (split_part: true). " +
        "Returns matching rows plus count and total. Amounts: negative = outflow.",
      inputSchema: {
        plan_id: planIdParam,
        since_date: z.string().optional().describe("From date YYYY-MM-DD (inclusive)."),
        until_date: z.string().optional().describe("To date YYYY-MM-DD (inclusive)."),
        month: z.string().optional().describe("Shortcut for a whole month (YYYY-MM / current / previous); overrides dates."),
        account: z.string().optional().describe("Account id or name (partial match)."),
        category: z.string().optional().describe("Category id or name (partial match)."),
        group: z.string().optional().describe("Category group id or name."),
        payee: z.string().optional().describe("Payee name substring or id."),
        text: z.string().optional().describe("Case-insensitive search in memo and payee name."),
        direction: z.enum(["outflow", "inflow", "any"]).optional().describe("Default any."),
        min_amount: z.number().optional().describe("Minimum absolute amount, in currency units."),
        max_amount: z.number().optional().describe("Maximum absolute amount, in currency units."),
        status: z
          .array(z.enum(["unapproved", "uncategorized", "uncleared", "cleared", "reconciled", "flagged"]))
          .optional()
          .describe("Only transactions matching ALL of these statuses."),
        exclude_transfers: z.boolean().optional().describe("Drop transfers between accounts (default false)."),
        sort: z.enum(["date_desc", "date_asc", "largest", "smallest"]).optional().describe("Default date_desc. largest = by absolute amount."),
        limit: z.number().int().min(1).max(1000).optional().describe("Max rows returned (default 100). Totals cover all matches."),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const p = await ynab.getPlan(a.plan_id);
      const { since, until } = resolvePeriod(a);
      const accIds = a.account ? new Set(resolveMany(p.accounts.values(), a.account, "account").map((x) => x.id)) : null;
      const catIds = a.category ? new Set(resolveMany(p.categories.values(), a.category, "category").map((x) => x.id)) : null;
      const grpId = a.group ? resolveOne(p.categoryGroups.values(), a.group, "category group").id : null;
      const grpCats = grpId ? new Set([...p.categories.values()].filter((c) => c.category_group_id === grpId).map((c) => c.id)) : null;
      const payeeQ = a.payee?.toLowerCase();
      const textQ = a.text?.toLowerCase();
      const minA = a.min_amount !== undefined ? toMilli(Math.abs(a.min_amount)) : null;
      const maxA = a.max_amount !== undefined ? toMilli(Math.abs(a.max_amount)) : null;
      const st = new Set(a.status ?? []);

      const matches = buildLines(p).filter((l) => {
        if (since && l.date < since) return false;
        if (until && l.date > until) return false;
        if (accIds && !accIds.has(l.account_id)) return false;
        if (catIds && !(l.category_id && catIds.has(l.category_id))) return false;
        if (grpCats && !(l.category_id && grpCats.has(l.category_id))) return false;
        if (payeeQ && !(l.payee_id === a.payee || (l.payee ?? "").toLowerCase().includes(payeeQ))) return false;
        if (textQ && !`${l.memo ?? ""} ${l.payee ?? ""}`.toLowerCase().includes(textQ)) return false;
        if (a.direction === "outflow" && l.amount >= 0) return false;
        if (a.direction === "inflow" && l.amount <= 0) return false;
        const abs = Math.abs(l.amount);
        if (minA !== null && abs < minA) return false;
        if (maxA !== null && abs > maxA) return false;
        if (a.exclude_transfers && l.transfer_account_id) return false;
        if (st.has("unapproved") && l.approved) return false;
        if (st.has("uncategorized") && classifyLine(l, p) !== "uncategorized") return false;
        if (st.has("uncleared") && l.cleared !== "uncleared") return false;
        if (st.has("cleared") && l.cleared !== "cleared") return false;
        if (st.has("reconciled") && l.cleared !== "reconciled") return false;
        if (st.has("flagged") && !l.flag) return false;
        return true;
      });

      const sort = a.sort ?? "date_desc";
      matches.sort((x, y) => {
        if (sort === "date_asc") return x.date.localeCompare(y.date);
        if (sort === "largest") return Math.abs(y.amount) - Math.abs(x.amount);
        if (sort === "smallest") return Math.abs(x.amount) - Math.abs(y.amount);
        return y.date.localeCompare(x.date);
      });
      const limit = a.limit ?? 100;
      const outflow = matches.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
      const inflow = matches.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
      return json({
        ...syncInfo(p),
        period: { since: since ?? null, until: until ?? null },
        count: matches.length,
        returned: Math.min(limit, matches.length),
        total_outflow: fromMilli(outflow),
        total_inflow: fromMilli(inflow),
        net: fromMilli(outflow + inflow),
        transactions: matches.slice(0, limit).map(lineView),
      });
    }),
  );

  // -------------------------------------------------------- spending report
  server.registerTool(
    "spending_report",
    {
      title: "Spending / income report",
      description:
        "Aggregates on-budget transactions for a period, grouped by category, category group, payee, account, month or week. " +
        "Spending = categorized outflows minus refunds; transfers between budget accounts are excluded; " +
        'income = inflows to "Ready to Assign". Returns per-group totals, share of total, monthly average and overall totals.',
      inputSchema: {
        plan_id: planIdParam,
        since_date: z.string().optional().describe("From YYYY-MM-DD (default: first day of the month 2 months ago)."),
        until_date: z.string().optional().describe("To YYYY-MM-DD (default: today)."),
        month: z.string().optional().describe("Shortcut for one whole month; overrides dates."),
        group_by: z.enum(["category", "group", "payee", "account", "month", "week"]).optional().describe("Default category."),
        kind: z.enum(["expense", "income"]).optional().describe("expense (default) or income."),
        category: z.string().optional().describe("Restrict to a category (id/name)."),
        group: z.string().optional().describe("Restrict to a category group (id/name)."),
        payee: z.string().optional().describe("Restrict to payees matching this substring."),
        account: z.string().optional().describe("Restrict to an account (id/name)."),
        top: z.number().int().min(1).max(500).optional().describe("Return at most this many groups (default 50)."),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const p = await ynab.getPlan(a.plan_id);
      let { since, until } = resolvePeriod(a);
      since ??= addMonths(normalizeMonth("current"), -2);
      until ??= todayIso();
      const kind = a.kind ?? "expense";
      const groupBy = a.group_by ?? "category";
      const catIds = a.category ? new Set(resolveMany(p.categories.values(), a.category, "category").map((x) => x.id)) : null;
      const grpId = a.group ? resolveOne(p.categoryGroups.values(), a.group, "category group").id : null;
      const accIds = a.account ? new Set(resolveMany(p.accounts.values(), a.account, "account").map((x) => x.id)) : null;
      const payeeQ = a.payee?.toLowerCase();

      let income = 0, expense = 0, uncategorized = 0;
      const buckets = new Map<string, { key: string; outflow: number; inflow: number; count: number }>();
      const weekKey = (d: string) => {
        const dt = new Date(d + "T00:00:00Z");
        const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
        return addDays(d, -dow);
      };

      for (const l of buildLines(p)) {
        if (l.date < since || l.date > until) continue;
        if (accIds && !accIds.has(l.account_id)) continue;
        if (payeeQ && !(l.payee ?? "").toLowerCase().includes(payeeQ)) continue;
        const cls = classifyLine(l, p);
        if (cls === "income") income += l.amount;
        else if (cls === "expense") expense += l.amount;
        else if (cls === "uncategorized") uncategorized += l.amount;
        if (cls !== kind) continue;
        if (catIds && !(l.category_id && catIds.has(l.category_id))) continue;
        if (grpId && p.categories.get(l.category_id ?? "")?.category_group_id !== grpId) continue;

        const key =
          groupBy === "category" ? `${l.category_group ?? "?"} / ${l.category ?? "?"}`
          : groupBy === "group" ? (l.category_group ?? "?")
          : groupBy === "payee" ? (l.payee ?? "(no payee)")
          : groupBy === "account" ? l.account
          : groupBy === "month" ? l.date.slice(0, 7)
          : weekKey(l.date);
        const b = buckets.get(key) ?? { key, outflow: 0, inflow: 0, count: 0 };
        if (l.amount < 0) b.outflow += -l.amount;
        else b.inflow += l.amount;
        b.count++;
        buckets.set(key, b);
      }

      const months = Math.max(
        1,
        (new Date(until + "T00:00:00Z").getTime() - new Date(since + "T00:00:00Z").getTime()) / (30.44 * 86400_000),
      );
      // For expenses the "total" is net spending (outflow - refunds); for income it's net inflow.
      const total = (b: { outflow: number; inflow: number }) => (kind === "expense" ? b.outflow - b.inflow : b.inflow - b.outflow);
      const all = [...buckets.values()];
      const grand = all.reduce((s, b) => s + total(b), 0);
      const sorted =
        groupBy === "month" || groupBy === "week"
          ? all.sort((x, y) => x.key.localeCompare(y.key))
          : all.sort((x, y) => total(y) - total(x));
      const top = a.top ?? 50;
      return json({
        ...syncInfo(p),
        period: { since, until, months: round(months, 1) },
        kind,
        group_by: groupBy,
        totals: {
          income: fromMilli(income),
          spending: fromMilli(-expense),
          net: fromMilli(income + expense),
          uncategorized: fromMilli(uncategorized),
          selected_total: fromMilli(grand),
          selected_monthly_avg: round((fromMilli(grand) ?? 0) / months),
        },
        groups: sorted.slice(0, top).map((b) => ({
          [groupBy]: b.key,
          total: fromMilli(total(b)),
          ...(b.inflow && kind === "expense" ? { refunds: fromMilli(b.inflow) } : {}),
          count: b.count,
          share_pct: grand ? round((total(b) / grand) * 100, 1) : null,
          ...(groupBy !== "month" && groupBy !== "week" ? { monthly_avg: round((fromMilli(total(b)) ?? 0) / months) } : {}),
        })),
        ...(sorted.length > top ? { omitted_groups: sorted.length - top } : {}),
      });
    }),
  );

  // ------------------------------------------------------------------ payees
  server.registerTool(
    "get_payees",
    {
      title: "Payees",
      description: "Lists payees (optionally filtered by name), with transaction count, total spent and last transaction date.",
      inputSchema: {
        plan_id: planIdParam,
        search: z.string().optional().describe("Name substring."),
        include_transfers: z.boolean().optional().describe("Include transfer payees (default false)."),
        limit: z.number().int().min(1).max(1000).optional().describe("Default 100, sorted by transaction count."),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, search, include_transfers, limit }) => {
      const p = await ynab.getPlan(plan_id);
      const stats = new Map<string, { n: number; sum: number; last: string }>();
      for (const l of buildLines(p)) {
        if (!l.payee_id) continue;
        const s = stats.get(l.payee_id) ?? { n: 0, sum: 0, last: "" };
        s.n++;
        s.sum += l.amount;
        if (l.date > s.last) s.last = l.date;
        stats.set(l.payee_id, s);
      }
      const q = search?.toLowerCase();
      const rows = [...p.payees.values()]
        .filter((x) => (include_transfers || !x.transfer_account_id) && (!q || x.name.toLowerCase().includes(q)))
        .map((x) => {
          const s = stats.get(x.id);
          return { id: x.id, name: x.name, transactions: s?.n ?? 0, net_amount: fromMilli(s?.sum ?? 0), last_date: s?.last || null };
        })
        .sort((x, y) => y.transactions - x.transactions);
      return json({ ...syncInfo(p), count: rows.length, payees: rows.slice(0, limit ?? 100) });
    }),
  );

  // -------------------------------------------------- scheduled transactions
  server.registerTool(
    "get_scheduled_transactions",
    {
      title: "Scheduled / recurring transactions",
      description:
        "Upcoming and recurring scheduled transactions with frequency and next date, plus an estimate of monthly recurring outflow/inflow.",
      inputSchema: {
        plan_id: planIdParam,
        days_ahead: z.number().int().min(1).max(3660).optional().describe("Only those whose next date is within N days."),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, days_ahead }) => {
      const p = await ynab.getPlan(plan_id);
      const horizon = days_ahead ? addDays(todayIso(), days_ahead) : null;
      const name = (id: string | null, map: Map<string, { name: string }>) => (id ? (map.get(id)?.name ?? null) : null);
      let monthlyOut = 0, monthlyIn = 0;
      const rows = [...p.scheduled.values()]
        .filter((s) => !horizon || s.date_next <= horizon)
        .sort((a, b) => a.date_next.localeCompare(b.date_next))
        .map((s) => {
          const perMonth = (FREQ_PER_MONTH[s.frequency] ?? 0) * s.amount;
          if (!s.transfer_account_id) {
            if (perMonth < 0) monthlyOut += perMonth;
            else monthlyIn += perMonth;
          }
          const subs = p.scheduledSubtransactionsOf(s.id);
          return {
            id: s.id,
            next_date: s.date_next,
            frequency: s.frequency,
            amount: fromMilli(s.amount),
            account: name(s.account_id, p.accounts),
            payee: name(s.payee_id, p.payees),
            category: subs.length ? "Split" : name(s.category_id, p.categories),
            ...(s.memo ? { memo: s.memo } : {}),
            ...(s.transfer_account_id ? { transfer: true } : {}),
            ...(subs.length
              ? { splits: subs.map((x) => ({ amount: fromMilli(x.amount), category: name(x.category_id, p.categories), memo: x.memo })) }
              : {}),
          };
        });
      return json({
        ...syncInfo(p),
        count: rows.length,
        estimated_monthly_recurring_outflow: fromMilli(monthlyOut),
        estimated_monthly_recurring_inflow: fromMilli(monthlyIn),
        scheduled: rows,
      });
    }),
  );

  // --------------------------------------------------------- money movements
  server.registerTool(
    "get_money_movements",
    {
      title: "Money movements",
      description: "Money moved between categories (or to/from Ready to Assign) — shows how the budget was re-shuffled in a month.",
      inputSchema: {
        plan_id: planIdParam,
        month: z.string().optional().describe('Month YYYY-MM / "current" (default) / "previous".'),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, month }) => {
      const p = await ynab.getPlan(plan_id);
      const m = normalizeMonth(month);
      const data = await ynab.client.request<{ money_movements: any[] }>(
        "GET",
        `/plans/${encodeURIComponent(p.id)}/months/${m}/money_movements`,
      );
      const cat = (id: string | null) => (id ? (p.categories.get(id)?.name ?? id) : "Ready to Assign");
      const rows = data.money_movements.map((x) => ({
        moved_at: x.moved_at,
        from: cat(x.from_category_id),
        to: cat(x.to_category_id),
        amount: fromMilli(x.amount),
        ...(x.note ? { note: x.note } : {}),
      }));
      return json({ ...syncInfo(p), month: m.slice(0, 7), count: rows.length, movements: rows });
    }),
  );

  // -------------------------------------------------------------- sync info
  server.registerTool(
    "sync_status",
    {
      title: "Sync status / refresh",
      description:
        "Shows cache freshness and how many YNAB API requests were used in the last hour (limit 200). " +
        "Pass refresh=true to pull the latest changes from YNAB right now.",
      inputSchema: {
        plan_id: planIdParam,
        refresh: z.boolean().optional().describe("Force a delta sync now."),
      },
      annotations: READ,
    },
    safe(async ({ plan_id, refresh }) => {
      const p = await ynab.getPlan(plan_id, !!refresh);
      return json({
        ...syncInfo(p),
        plan_id: p.id,
        server_knowledge: p.serverKnowledge,
        cache_ttl_seconds: config.cacheTtlSeconds,
        api_requests_last_hour: ynab.client.requestsLastHour(),
        api_limit_per_hour: 200,
        counts: {
          accounts: p.accounts.size,
          categories: p.categories.size,
          payees: p.payees.size,
          transactions: p.transactions.size,
          months: p.months.size,
          scheduled: p.scheduled.size,
        },
        writes_enabled: config.allowWrites,
      });
    }),
  );

  if (config.allowWrites) registerWriteTools(server, ynab);
}

// ======================================================================
// Write tools (only registered when YNAB_ALLOW_WRITES=true)
// ======================================================================

function registerWriteTools(server: McpServer, ynab: YnabService) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
  const flag = z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).nullable().optional();

  server.registerTool(
    "create_transaction",
    {
      title: "Create transaction",
      description: "Creates a transaction. amount is in currency units: negative = outflow (expense), positive = inflow.",
      inputSchema: {
        plan_id: planIdParam,
        account: z.string().describe("Account id or name."),
        date: z.string().describe("YYYY-MM-DD (not in the future)."),
        amount: z.number().describe("Currency units; negative = outflow."),
        payee_name: z.string().optional().describe("Payee name (created if new)."),
        category: z.string().optional().describe("Category id or name."),
        memo: z.string().max(500).optional(),
        cleared: z.enum(["cleared", "uncleared"]).optional(),
        approved: z.boolean().optional().describe("Default true."),
        flag_color: flag,
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      const p = await ynab.getPlan(a.plan_id);
      const acc = resolveOne(p.accounts.values(), a.account, "account");
      const cat = a.category ? resolveOne(p.categories.values(), a.category, "category") : null;
      const data = await ynab.client.request<{ transaction: any }>("POST", `/plans/${p.id}/transactions`, {
        body: {
          transaction: {
            account_id: acc.id,
            date: validateDate(a.date, "date"),
            amount: toMilli(a.amount),
            payee_name: a.payee_name,
            category_id: cat?.id,
            memo: a.memo,
            cleared: a.cleared ?? "uncleared",
            approved: a.approved ?? true,
            flag_color: a.flag_color,
          },
        },
      });
      ynab.invalidate(p.id);
      const t = data.transaction;
      return json({ created: { id: t.id, date: t.date, amount: fromMilli(t.amount), account: t.account_name, payee: t.payee_name, category: t.category_name } });
    }),
  );

  server.registerTool(
    "update_transactions",
    {
      title: "Update transactions",
      description:
        "Updates one or many existing transactions (e.g. categorize, approve, change memo/flag/date/amount). Only the given fields change.",
      inputSchema: {
        plan_id: planIdParam,
        updates: z
          .array(
            z.object({
              id: z.string().describe("Transaction id."),
              category: z.string().optional().describe("Category id or name."),
              payee_name: z.string().optional(),
              memo: z.string().max(500).nullable().optional(),
              amount: z.number().optional().describe("Currency units; negative = outflow."),
              date: z.string().optional(),
              approved: z.boolean().optional(),
              cleared: z.enum(["cleared", "uncleared"]).optional(),
              flag_color: flag,
            }),
          )
          .min(1)
          .max(100),
      },
      annotations: WRITE,
    },
    safe(async ({ plan_id, updates }) => {
      const p = await ynab.getPlan(plan_id);
      const txs = updates.map((u) => {
        const t: Record<string, unknown> = { id: u.id };
        if (u.category !== undefined) t.category_id = resolveOne(p.categories.values(), u.category, "category").id;
        if (u.payee_name !== undefined) t.payee_name = u.payee_name;
        if (u.memo !== undefined) t.memo = u.memo;
        if (u.amount !== undefined) t.amount = toMilli(u.amount);
        if (u.date !== undefined) t.date = validateDate(u.date, "date");
        if (u.approved !== undefined) t.approved = u.approved;
        if (u.cleared !== undefined) t.cleared = u.cleared;
        if (u.flag_color !== undefined) t.flag_color = u.flag_color;
        return t;
      });
      const data = await ynab.client.request<{ transaction_ids: string[] }>("PATCH", `/plans/${p.id}/transactions`, {
        body: { transactions: txs },
      });
      ynab.invalidate(p.id);
      return json({ updated: data.transaction_ids?.length ?? txs.length, ids: data.transaction_ids });
    }),
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Delete transaction",
      description: "Deletes a transaction by id. Irreversible via the API — confirm with the user first.",
      inputSchema: { plan_id: planIdParam, id: z.string().describe("Transaction id.") },
      annotations: { ...WRITE, destructiveHint: true },
    },
    safe(async ({ plan_id, id }) => {
      const p = await ynab.getPlan(plan_id);
      await ynab.client.request("DELETE", `/plans/${p.id}/transactions/${encodeURIComponent(id)}`);
      ynab.invalidate(p.id);
      return json({ deleted: id });
    }),
  );

  server.registerTool(
    "set_category_assigned",
    {
      title: "Assign money to a category",
      description: "Sets the assigned (budgeted) amount of a category for a month. amount is the new total, not a delta.",
      inputSchema: {
        plan_id: planIdParam,
        category: z.string().describe("Category id or name."),
        month: z.string().optional().describe('YYYY-MM or "current" (default).'),
        amount: z.number().describe("New assigned amount in currency units."),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe(async ({ plan_id, category, month, amount }) => {
      const p = await ynab.getPlan(plan_id);
      const c = resolveOne(p.categories.values(), category, "category");
      const m = normalizeMonth(month);
      const data = await ynab.client.request<{ category: any }>("PATCH", `/plans/${p.id}/months/${m}/categories/${c.id}`, {
        body: { category: { budgeted: toMilli(amount) } },
      });
      ynab.invalidate(p.id);
      return json({ month: m.slice(0, 7), category: categoryView(data.category) });
    }),
  );
}
