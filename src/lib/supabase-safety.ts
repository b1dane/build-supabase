// Central safety contract for the read-only dashboard.
// - Only these 4 public tables may ever be queried.
// - Only GET / SELECT is allowed. No POST / PATCH / DELETE / RPC writes.
// - Only the publishable (anon) key may be used. service_role is never read.
// - No Alpaca / Kalshi / broker order-placement code exists anywhere in this app.

export const PROJECT_REF = "garixvwvqhapmaluitol";
export const DEFAULT_SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

export const ALLOWED_TABLES = [
  "daily_balances",
  "trades",
  "bot_logs",
  "kalshi_trades",
] as const;

export type AllowedTable = (typeof ALLOWED_TABLES)[number];

export function isAllowedTable(t: string): t is AllowedTable {
  return (ALLOWED_TABLES as readonly string[]).includes(t);
}

export function sanitizeLimit(raw: unknown, fallback = 50): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

export function redactUrlForDisplay(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return "(invalid url)";
  }
}
