import { NextResponse } from "next/server";
import { computePaperPortfolioSummary, getPaperStore, settleOpenPaperOrders } from "@/lib/paper-simulator-store";

export const dynamic = "force-dynamic";

// Manual, on-demand settlement check. Never scheduled, never auto-run.
export async function POST() {
  const store = getPaperStore();
  const res = await settleOpenPaperOrders(store);
  return NextResponse.json({
    ok: true,
    ...res,
    run: store.run,
    portfolio: computePaperPortfolioSummary(store),
    orders: store.orders,
    auditLog: store.auditLog,
  });
}
