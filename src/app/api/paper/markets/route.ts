import { NextResponse } from "next/server";
import { discoverLiveKalshiBtc15mMarkets } from "@/lib/kalshi-btc15m-verifier";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await discoverLiveKalshiBtc15mMarkets();
  return NextResponse.json({
    ok: report.fetchError === null,
    ...report,
  });
}
