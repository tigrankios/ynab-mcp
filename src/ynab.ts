/**
 * Thin YNAB API client + delta-synced in-memory cache.
 *
 * YNAB allows 200 requests per hour per token, so the whole plan is synced with
 * a single `GET /plans/{plan_id}` call and then kept fresh with delta requests
 * (`last_knowledge_of_server`). Every read tool works off this cache.
 */

const BASE_URL = process.env.YNAB_API_BASE_URL?.replace(/\/$/, "") || "https://api.ynab.com/v1";

export class YnabError extends Error {
  constructor(
    public status: number,
    public errorName: string,
    public detail: string,
  ) {
    super(`YNAB API error ${status} (${errorName}): ${detail}`);
  }
}

// ---------- Raw API shapes (only the fields we use) ----------

export interface CurrencyFormat {
  iso_code: string;
  decimal_digits: number;
  currency_symbol: string;
}

export interface Account {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  note: string | null;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  transfer_payee_id: string | null;
  direct_import_linked?: boolean;
  direct_import_in_error?: boolean;
  last_reconciled_at?: string | null;
  deleted: boolean;
}

export interface CategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
}

export interface Category {
  id: string;
  category_group_id: string;
  category_group_name?: string;
  name: string;
  hidden: boolean;
  note: string | null;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type: string | null;
  goal_target: number | null;
  goal_target_date?: string | null;
  goal_target_month?: string | null;
  goal_percentage_complete: number | null;
  goal_under_funded: number | null;
  goal_overall_left: number | null;
  goal_months_to_budget?: number | null;
  goal_cadence?: number | null;
  goal_snoozed_at?: string | null;
  deleted: boolean;
}

export interface Payee {
  id: string;
  name: string;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface MonthBase {
  month: string;
  note: string | null;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money: number | null;
  deleted: boolean;
  categories?: Category[];
}

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  memo: string | null;
  cleared: "cleared" | "uncleared" | "reconciled";
  approved: boolean;
  flag_color: string | null;
  flag_name?: string | null;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  import_payee_name?: string | null;
  deleted: boolean;
}

export interface SubTransaction {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface ScheduledTransaction {
  id: string;
  date_first: string;
  date_next: string;
  frequency: string;
  amount: number;
  memo: string | null;
  flag_color: string | null;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface ScheduledSubTransaction {
  id: string;
  scheduled_transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

interface PlanExport {
  id: string;
  name: string;
  last_modified_on?: string;
  first_month?: string;
  last_month?: string;
  currency_format?: CurrencyFormat | null;
  accounts?: Account[];
  payees?: Payee[];
  category_groups?: CategoryGroup[];
  categories?: Category[];
  months?: MonthBase[];
  transactions?: Transaction[];
  subtransactions?: SubTransaction[];
  scheduled_transactions?: ScheduledTransaction[];
  scheduled_subtransactions?: ScheduledSubTransaction[];
}

// ---------- HTTP ----------

export class YnabClient {
  /** Timestamps of requests made in the last hour (YNAB uses a rolling 1h window). */
  private requestLog: number[] = [];

  constructor(private token: string) {}

  requestsLastHour(): number {
    const cutoff = Date.now() - 3600_000;
    this.requestLog = this.requestLog.filter((t) => t > cutoff);
    return this.requestLog.length;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    this.requestLog.push(Date.now());
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new YnabError(0, "network_error", (e as Error).message);
    }
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const err = json?.error;
      throw new YnabError(
        res.status,
        err?.name ?? res.statusText,
        err?.detail ?? (text.slice(0, 300) || "no details"),
      );
    }
    return json?.data as T;
  }
}

// ---------- Delta-synced plan cache ----------

function mergeById<T extends { id: string; deleted?: boolean }>(target: Map<string, T>, items?: T[]) {
  for (const item of items ?? []) {
    if (item.deleted) target.delete(item.id);
    else target.set(item.id, item);
  }
}

export interface MonthState extends Omit<MonthBase, "categories"> {
  categories: Map<string, Category>;
}

export class PlanCache {
  id: string;
  name = "";
  firstMonth?: string;
  lastMonth?: string;
  lastModifiedOn?: string;
  currency?: CurrencyFormat | null;
  serverKnowledge?: number;
  syncedAt = 0;
  stale = true;

  accounts = new Map<string, Account>();
  payees = new Map<string, Payee>();
  categoryGroups = new Map<string, CategoryGroup>();
  categories = new Map<string, Category>();
  months = new Map<string, MonthState>();
  transactions = new Map<string, Transaction>();
  subtransactions = new Map<string, SubTransaction>();
  scheduled = new Map<string, ScheduledTransaction>();
  scheduledSubs = new Map<string, ScheduledSubTransaction>();

  constructor(id: string) {
    this.id = id;
  }

  apply(plan: PlanExport, serverKnowledge: number) {
    this.id = plan.id ?? this.id;
    if (plan.name) this.name = plan.name;
    if (plan.first_month) this.firstMonth = plan.first_month;
    if (plan.last_month) this.lastMonth = plan.last_month;
    if (plan.last_modified_on) this.lastModifiedOn = plan.last_modified_on;
    if (plan.currency_format !== undefined) this.currency = plan.currency_format;

    mergeById(this.accounts, plan.accounts);
    mergeById(this.payees, plan.payees);
    mergeById(this.categoryGroups, plan.category_groups);
    mergeById(this.categories, plan.categories);
    mergeById(this.transactions, plan.transactions);
    mergeById(this.subtransactions, plan.subtransactions);
    mergeById(this.scheduled, plan.scheduled_transactions);
    mergeById(this.scheduledSubs, plan.scheduled_subtransactions);

    for (const m of plan.months ?? []) {
      if (m.deleted) {
        this.months.delete(m.month);
        continue;
      }
      const existing = this.months.get(m.month);
      const cats = existing?.categories ?? new Map<string, Category>();
      mergeById(cats, m.categories);
      const { categories: _ignored, ...rest } = m;
      this.months.set(m.month, { ...rest, categories: cats });
    }

    this.serverKnowledge = serverKnowledge;
    this.syncedAt = Date.now();
    this.stale = false;
  }

  subtransactionsOf(transactionId: string): SubTransaction[] {
    const out: SubTransaction[] = [];
    for (const s of this.subtransactions.values()) if (s.transaction_id === transactionId) out.push(s);
    return out;
  }

  scheduledSubtransactionsOf(id: string): ScheduledSubTransaction[] {
    const out: ScheduledSubTransaction[] = [];
    for (const s of this.scheduledSubs.values()) if (s.scheduled_transaction_id === id) out.push(s);
    return out;
  }
}

export class YnabService {
  readonly client: YnabClient;
  private plans = new Map<string, PlanCache>();
  private inflight = new Map<string, Promise<PlanCache>>();
  /** alias ("last-used"/"default") -> real plan id */
  private aliases = new Map<string, string>();

  constructor(
    token: string,
    private defaultPlanId: string,
    private ttlMs: number,
  ) {
    this.client = new YnabClient(token);
  }

  resolvePlanId(planId?: string): string {
    const id = planId?.trim() || this.defaultPlanId;
    return this.aliases.get(id) ?? id;
  }

  /** Returns a fresh-enough cache for the plan, doing a (delta) sync if needed. */
  async getPlan(planId?: string, forceRefresh = false): Promise<PlanCache> {
    const requested = planId?.trim() || this.defaultPlanId;
    const id = this.resolvePlanId(requested);
    const cached = this.plans.get(id);
    if (cached && !forceRefresh && !cached.stale && Date.now() - cached.syncedAt < this.ttlMs) {
      return cached;
    }
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const p = (async () => {
      const cache = cached ?? new PlanCache(id);
      const data = await this.client.request<{ plan: PlanExport; server_knowledge: number }>(
        "GET",
        `/plans/${encodeURIComponent(id)}`,
        { query: { last_knowledge_of_server: cache.serverKnowledge } },
      );
      cache.apply(data.plan, data.server_knowledge);
      this.plans.set(cache.id, cache);
      if (requested !== cache.id) this.aliases.set(requested, cache.id);
      return cache;
    })();
    this.inflight.set(id, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(id);
    }
  }

  /** Mark a plan's cache as stale so the next read performs a delta sync. */
  invalidate(planId?: string) {
    const c = this.plans.get(this.resolvePlanId(planId));
    if (c) c.stale = true;
  }

  cachedPlans(): PlanCache[] {
    return [...this.plans.values()];
  }
}
