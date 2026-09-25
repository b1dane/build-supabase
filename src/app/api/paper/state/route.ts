import { NextResponse } from "next/server";
import { computePaperPortfolioSummary, getPaperStore } from "@/lib/paper-simulator-store";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getPaperStore();
  const portfolio = computePaperPortfolioSummary(store);

  // Verify the 4 existing tables remain untouched
  const existingTableCounts: Record<string, number | null> = {};
  for (const t of ["daily_balances", "trades", "bot_logs", "kalshi_trades"] as const) {
    try {
      const r = await db.execute(sql.raw(`SELECT COUNT(*)::int AS c FROM "${t}"`));
      const row = (r.rows?.[0] ?? {}) as { c?: number };
      existingTableCounts[t] = typeof row.c === "number" ? row.c : null;
    } catch {
      existingTableCounts[t] = null;
    }
  }

  return NextResponse.json({
    ok: true,
    label: "PAPER / SIMULATED — ISOLATED FROM EXISTING TABLES",
    mode: store.mode,
    liveTradingEnabled: store.liveTradingEnabled,
    existingTablesUntouched: store.existingTablesUntouched,
    existingTableCounts,
    config: store.config,
    run: store.run,
    portfolio,
    orders: store.orders,
    decisions: store.decisions,
    auditLog: store.auditLog,
  });
}
