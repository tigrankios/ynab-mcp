export interface Config {
  ynabToken: string;
  defaultPlanId: string;
  authToken: string | undefined;
  port: number;
  cacheTtlSeconds: number;
  allowWrites: boolean;
}

export function loadConfig(): Config {
  const ynabToken = process.env.YNAB_ACCESS_TOKEN?.trim();
  if (!ynabToken) {
    throw new Error("YNAB_ACCESS_TOKEN is not set. Create a Personal Access Token in YNAB → Account Settings → Developer Settings.");
  }
  return {
    ynabToken,
    defaultPlanId: process.env.YNAB_PLAN_ID?.trim() || "last-used",
    authToken: process.env.MCP_AUTH_TOKEN?.trim() || undefined,
    port: Number(process.env.PORT) || 3000,
    cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS) || 300,
    allowWrites: /^(1|true|yes)$/i.test(process.env.YNAB_ALLOW_WRITES ?? ""),
  };
}
