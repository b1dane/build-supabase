import { NextResponse } from "next/server";
import { computePaperPortfolioSummary, configurePaperSimulator, getPaperStore } from "@/lib/paper-simulator-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = configurePaperSimulator(body);
    if (!res.ok) {
      return NextResponse.json(res, { status: 422 });
    }
    const store = getPaperStore();
    return NextResponse.json({
      ok: true,
      config: res.config,
      portfolio: computePaperPortfolioSummary(store),
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
