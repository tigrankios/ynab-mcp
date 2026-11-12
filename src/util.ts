import type { Category, PlanCache, SubTransaction, Transaction } from "./ynab.js";

/** YNAB stores money in milliunits (1000 = 1.00). */
export const fromMilli = (m: number | null | undefined): number | null =>
  m === null || m === undefined ? null : Math.round(m) / 1000;

export const toMilli = (amount: number): number => Math.round(amount * 1000);

export const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Normalises "current" | "YYYY-MM" | "YYYY-MM-DD" to "YYYY-MM-01". */
export function normalizeMonth(input?: string): string {
  if (!input || input === "current") return todayIso().slice(0, 7) + "-01";
  if (input === "previous" || input === "last") {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7) + "-01";
  }
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid month "${input}". Use YYYY-MM, YYYY-MM-DD, "current" or "previous".`);
  return `${m[1]}-${m[2]}-01`;
}

export function monthEnd(month01: string): string {
  const d = new Date(month01 + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export function addMonths(month01: string, n: number): string {
  const d = new Date(month01 + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7) + "-01";
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function validateDate(d: string | undefined, field: string): string | undefined {
  if (d === undefined || d === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`${field} must be YYYY-MM-DD, got "${d}"`);
  return d;
}

export const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

export function isReadyToAssign(c: Category | undefined, plan: PlanCache): boolean {
  if (!c) return false;
  const group = plan.categoryGroups.get(c.category_group_id);
  return (
    /ready to assign|to be budgeted/i.test(c.name) &&
    (!group || /internal master/i.test(group.name) || /^inflow/i.test(c.name))
  );
}

export function isInternalGroup(groupName: string | undefined): boolean {
  return !!groupName && /internal master category|hidden categories/i.test(groupName);
}

// ---------- name / id resolution ----------

interface Named {
  id: string;
  name: string;
}

/**
 * Finds an entity by id, exact name (case-insensitive), or unique substring.
 * Throws a helpful error listing candidates otherwise.
 */
export function resolveOne<T extends Named>(items: Iterable<T>, query: string, kind: string): T {
  const all = [...items];
  const q = query.trim().toLowerCase();
  const byId = all.find((x) => x.id.toLowerCase() === q);
  if (byId) return byId;
  const exact = all.filter((x) => x.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = exact.length > 1 ? exact : all.filter((x) => x.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) {
    throw new Error(`No ${kind} matches "${query}".`);
  }
  const names = partial.slice(0, 15).map((x) => `${x.name} (${x.id})`);
  throw new Error(`"${query}" is ambiguous; matching ${kind}s: ${names.join("; ")}`);
}

/** Like resolveOne but returns all matches for a substring (used for filters). */
export function resolveMany<T extends Named>(items: Iterable<T>, query: string, kind: string): T[] {
  const all = [...items];
  const q = query.trim().toLowerCase();
  const byId = all.filter((x) => x.id.toLowerCase() === q);
  if (byId.length) return byId;
  const exact = all.filter((x) => x.name.toLowerCase() === q);
  if (exact.length) return exact;
  const partial = all.filter((x) => x.name.toLowerCase().includes(q));
  if (!partial.length) throw new Error(`No ${kind} matches "${query}".`);
  return partial;
}

// ---------- ledger lines (transactions with splits expanded) ----------

export interface Line {
  transaction_id: string;
  subtransaction_id?: string;
  date: string;
  amount: number; // milliunits
  account_id: string;
  account: string;
  on_budget: boolean;
  payee_id: string | null;
  payee: string | null;
  category_id: string | null;
  category: string | null;
  category_group: string | null;
  memo: string | null;
  cleared: Transaction["cleared"];
  approved: boolean;
  flag: string | null;
  transfer_account_id: string | null;
  is_split_part: boolean;
}

/** Expands split transactions into one line per subtransaction, joined with names. */
export function buildLines(plan: PlanCache): Line[] {
  const subsByParent = new Map<string, SubTransaction[]>();
  for (const s of plan.subtransactions.values()) {
    const arr = subsByParent.get(s.transaction_id) ?? [];
    arr.push(s);
    subsByParent.set(s.transaction_id, arr);
  }
  const catInfo = (id: string | null) => {
    if (!id) return { category: null, category_group: null };
    const c = plan.categories.get(id);
    return {
      category: c?.name ?? null,
      category_group: c ? (plan.categoryGroups.get(c.category_group_id)?.name ?? null) : null,
    };
  };
  const lines: Line[] = [];
  for (const t of plan.transactions.values()) {
    const acc = plan.accounts.get(t.account_id);
    const base = {
      transaction_id: t.id,
      date: t.date,
      account_id: t.account_id,
      account: acc?.name ?? t.account_id,
      on_budget: acc?.on_budget ?? true,
      cleared: t.cleared,
      approved: t.approved,
      flag: t.flag_color,
    };
    const subs = subsByParent.get(t.id);
    if (subs && subs.length) {
      for (const s of subs) {
        const payeeId = s.payee_id ?? t.payee_id;
        lines.push({
          ...base,
          subtransaction_id: s.id,
          amount: s.amount,
          payee_id: payeeId,
          payee: payeeId ? (plan.payees.get(payeeId)?.name ?? null) : null,
          category_id: s.category_id,
          ...catInfo(s.category_id),
          memo: s.memo ?? t.memo,
          transfer_account_id: s.transfer_account_id,
          is_split_part: true,
        });
      }
    } else {
      lines.push({
        ...base,
        amount: t.amount,
        payee_id: t.payee_id,
        payee: t.payee_id ? (plan.payees.get(t.payee_id)?.name ?? null) : null,
        category_id: t.category_id,
        ...catInfo(t.category_id),
        memo: t.memo,
        transfer_account_id: t.transfer_account_id,
        is_split_part: false,
      });
    }
  }
  return lines;
}

/** Classification used by spending/income reports. */
export function classifyLine(
  line: Line,
  plan: PlanCache,
): "income" | "expense" | "transfer" | "uncategorized" | "tracking" {
  if (!line.on_budget) return "tracking";
  if (line.transfer_account_id) {
    const other = plan.accounts.get(line.transfer_account_id);
    // Transfer to a tracking account is categorised and counts as spending.
    if (other && !other.on_budget && line.category_id) {
      return isReadyToAssign(plan.categories.get(line.category_id), plan) ? "income" : "expense";
    }
    return "transfer";
  }
  if (!line.category_id) return "uncategorized";
  const c = plan.categories.get(line.category_id);
  if (isReadyToAssign(c, plan)) return "income";
  if (c && /^uncategorized$/i.test(c.name)) return "uncategorized";
  return "expense";
}
