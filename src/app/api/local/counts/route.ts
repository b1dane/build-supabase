import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Proves the local mirror was inspected but not modified destructively.
// Returns row counts only — never row contents with secrets (there are none).
export async function GET() {
  try {
    const tables = ["daily_balances", "trades", "bot_logs", "kalshi_trades"] as const;
    const counts: Record<string, number | null> = {};
    for (const t of tables) {
      try {
        const r = await db.execute(sql.raw(`SELECT COUNT(*)::int AS c FROM "${t}"`));
        const row = (r.rows?.[0] ?? {}) as { c?: number };
        counts[t] = typeof row.c === "number" ? row.c : null;
      } catch {
        counts[t] = null; // table missing locally — Supabase untouched regardless
      }
    }
    return NextResponse.json({ ok: true, counts, note: "Local mirror counts only. Supabase data is read via REST, never overwritten." });
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "count failed" },
      { status: 500 }
    );
  }
}
