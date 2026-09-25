import { NextResponse } from "next/server";
import { computePaperPortfolioSummary, controlPaperRun, getPaperStore } from "@/lib/paper-simulator-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action?: string };
    const res = controlPaperRun(body?.action);
    if (!res.ok) {
      const status = res.code === "LIMITS_OR_STRATEGY_UNSET" ? 422 : 409;
      return NextResponse.json(res, { status });
    }
    const store = getPaperStore();
    return NextResponse.json({
      ok: true,
      run: res.run,
      portfolio: computePaperPortfolioSummary(store),
      orders: store.orders,
      auditLog: store.auditLog,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "BAD_JSON",
        message: e instanceof Error ? e.message : "Invalid JSON body.",
      },
      { status: 400 }
    );
  }
}
