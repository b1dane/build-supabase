import { NextResponse } from "next/server";
import {
  computePaperPortfolioSummary,
  getPaperStore,
  submitPaperOrder,
  SubmitPaperOrderInput,
} from "@/lib/paper-simulator-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SubmitPaperOrderInput;
    const res = submitPaperOrder(body);
    if (!res.ok) {
      const status = res.code.startsWith("RUN_") ? 409 : 422;
      return NextResponse.json(res, { status });
    }
    const store = getPaperStore();
    return NextResponse.json({
      ok: true,
      order: res.order,
      verification: res.verification,
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
