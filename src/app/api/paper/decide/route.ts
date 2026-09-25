import { NextResponse } from "next/server";
import { discoverLiveKalshiBtc15mMarkets, type MarketVerificationResult } from "@/lib/kalshi-btc15m-verifier";
import { fetchPriceContext } from "@/lib/kalshi-market-context";
import {
  applyStrategyRule,
  buildJevPayload,
  buildPrompt,
  callJev,
  jevStatusForDisplay,
  parseJevResponse,
} from "@/lib/jev-decision-engine";
import {
  computeAutoSize,
  computePaperPortfolioSummary,
  getPaperStore,
  recordDecision,
  submitPaperOrder,
  type PaperDecisionRecord,
} from "@/lib/paper-simulator-store";

export const dynamic = "force-dynamic";

// Engine status — never includes key material.
export async function GET() {
  const store = getPaperStore();
  return NextResponse.json({ ok: true, ...jevStatusForDisplay(), decisions: store.decisions });
}

type Mode = "dry-run" | "evaluate" | "evaluate-and-trade";

function pickMarket(markets: MarketVerificationResult[], ticker: string | null): MarketVerificationResult | null {
  if (ticker) return markets.find((m) => m.ticker === ticker) ?? null;
  const now = Date.now();
  // Currently trading window: active/open with close in the future; earliest close first.
  const live = markets
    .filter((m) => (m.status === "active" || m.status === "open") && m.closeTime && Date.parse(m.closeTime) > now)
    .sort((a, b) => Date.parse(a.closeTime!) - Date.parse(b.closeTime!));
  return live[0] ?? null;
}

export async function POST(req: Request) {
  const store = getPaperStore();
  let body: { ticker?: string; mode?: Mode; auto?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const mode: Mode = body.mode === "dry-run" || body.mode === "evaluate" || body.mode === "evaluate-and-trade" ? body.mode : "evaluate";
  const requestedTicker = typeof body.ticker === "string" && body.ticker.trim() ? body.ticker.trim() : null;
  const auto = body.auto === true;

  // Auto mode only ever operates inside a manually started, RUNNING session.
  if (auto && store.run?.status !== "RUNNING") {
    return NextResponse.json(
      { ok: false, code: `RUN_${store.run?.status ?? "IDLE_NOT_STARTED"}`, message: "Auto-evaluate is inactive: the simulation run is not RUNNING." },
      { status: 409 }
    );
  }

  // 1. Discover + verify (read-only). Never trust a caller-supplied market object here.
  const discovery = await discoverLiveKalshiBtc15mMarkets();
  if (discovery.fetchError) {
    return NextResponse.json({ ok: false, code: "KALSHI_DISCOVERY_FAILED", message: discovery.fetchError }, { status: 502 });
  }
  const market = pickMarket(discovery.verifiedMarkets, requestedTicker);
  if (!market) {
    return NextResponse.json(
      {
        ok: false,
        code: requestedTicker ? "TICKER_NOT_VERIFIED_IN_SCOPE" : "NO_ACTIVE_IN_SCOPE_MARKET",
        message: requestedTicker
          ? `"${requestedTicker}" is not currently a verified Kalshi BTC 15-minute Up/Down market. Nothing evaluated.`
          : "No currently-trading verified BTC 15-minute Up/Down market right now. Nothing evaluated; nothing invented.",
        verifiedCount: discovery.verifiedMarkets.length,
      },
      { status: 404 }
    );
  }

  // Auto mode: evaluate each market at most once per run.
  if (auto && store.decisions.some((d) => d.ticker === market.ticker && d.runId === store.run?.runId && d.mode === "evaluate-and-trade")) {
    return NextResponse.json({ ok: true, skipped: true, code: "ALREADY_EVALUATED_THIS_MARKET", ticker: market.ticker, message: `Already evaluated ${market.ticker} in this run.` });
  }

  // 2. Read-only context + prompt + payload
  const ctx = await fetchPriceContext(market);
  const prompt = buildPrompt(market, ctx);
  const payload = buildJevPayload(prompt);

  if (mode === "dry-run") {
    return NextResponse.json({
      ok: true,
      mode,
      market: { ticker: market.ticker, title: market.title, openTime: market.openTime, closeTime: market.closeTime, status: market.status },
      contextErrors: ctx.errors,
      prompt,
      payload, // no key material — the Authorization header is added server-side only when actually calling
      engine: jevStatusForDisplay(),
      note: "Dry run: nothing was sent to Jev and no paper order was considered.",
    });
  }

  // 3. Call Jev
  const call = await callJev(payload);
  const base: Omit<PaperDecisionRecord, "direction" | "conviction" | "shouldTrade" | "valid" | "reasoning" | "parseErrors" | "rawAnswers" | "ruleApplied" | "willTrade" | "side" | "sizedContracts" | "sizedStakeDollars" | "outcome" | "outcomeCode" | "outcomeMessage" | "orderId" | "latencyMs"> = {
    decisionId: `jev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    runId: store.run?.runId ?? null,
    createdAt: new Date().toISOString(),
    mode,
    ticker: market.ticker,
    engine: "jev-latest",
    promptChars: prompt.length,
  };

  if (!call.ok) {
    const rec: PaperDecisionRecord = {
      ...base,
      direction: "pass",
      conviction: 0,
      shouldTrade: false,
      valid: false,
      reasoning: "",
      parseErrors: [call.message],
      rawAnswers: "",
      ruleApplied: store.config?.engine.rule ?? "(unconfigured)",
      willTrade: false,
      side: null,
      sizedContracts: null,
      sizedStakeDollars: null,
      outcome: "ENGINE_ERROR",
      outcomeCode: call.code,
      outcomeMessage: call.message,
      orderId: null,
      latencyMs: call.latencyMs,
    };
    recordDecision(rec, store);
    return NextResponse.json(
      { ok: false, code: call.code, message: call.message, decision: rec, prompt: call.code === "JEV_NOT_CONFIGURED" ? prompt : undefined, engine: jevStatusForDisplay() },
      { status: call.code === "JEV_NOT_CONFIGURED" ? 428 : 502 }
    );
  }

  // 4. Parse + apply the strategy rule
  const decision = parseJevResponse(call.answers);
  const minConviction = store.config?.engine.minConviction ?? 1;
  const rule = applyStrategyRule(decision, minConviction);

  const rec: PaperDecisionRecord = {
    ...base,
    direction: decision.direction,
    conviction: decision.conviction,
    shouldTrade: decision.shouldTrade,
    valid: decision.valid,
    reasoning: decision.reasoning,
    parseErrors: decision.parseErrors,
    rawAnswers: decision.rawResponse,
    ruleApplied: rule.rule,
    willTrade: rule.trade,
    side: rule.side,
    sizedContracts: null,
    sizedStakeDollars: null,
    outcome: rule.trade ? "NOT_EXECUTED" : "NO_TRADE_SIGNAL",
    outcomeCode: rule.trade ? (mode === "evaluate" ? "EVALUATE_ONLY" : "PENDING") : "NO_SIGNAL",
    outcomeMessage: rule.reason,
    orderId: null,
    latencyMs: call.latencyMs,
  };

  // 5. Optionally execute through the full paper gate chain
  if (mode === "evaluate-and-trade" && rule.trade && rule.side) {
    const alreadyTraded = store.orders.some((o) => o.ticker === market.ticker && o.runId === store.run?.runId);
    if (alreadyTraded) {
      rec.outcome = "BLOCKED";
      rec.outcomeCode = "ALREADY_TRADED_THIS_MARKET";
      rec.outcomeMessage = `A paper order already exists on ${market.ticker} in this run; not adding a second.`;
    } else {
      const size = computeAutoSize(market, rule.side, store);
      if (!size.ok) {
        rec.outcome = "BLOCKED";
        rec.outcomeCode = size.code;
        rec.outcomeMessage = size.message;
      } else {
        rec.sizedContracts = size.contracts;
        rec.sizedStakeDollars = size.estStakeDollars;
        const submitted = submitPaperOrder(
          {
            market: {
              ticker: market.ticker,
              event_ticker: market.eventTicker,
              series_ticker: market.seriesTicker,
              title: market.title,
              market_type: "binary",
              status: market.status,
              open_time: market.openTime ?? undefined,
              close_time: market.closeTime ?? undefined,
              yes_ask_dollars: market.yesAskCents !== null ? (market.yesAskCents / 100).toFixed(4) : undefined,
              no_ask_dollars: market.noAskCents !== null ? (market.noAskCents / 100).toFixed(4) : undefined,
              last_price_dollars: market.lastPriceCents !== null ? (market.lastPriceCents / 100).toFixed(4) : undefined,
              rules_primary: market.rulesPrimary,
              rules_secondary: market.rulesSecondary,
              result: "",
              expiration_value: "",
            },
            series: { ticker: market.seriesTicker, title: "Bitcoin price up down", frequency: "fifteen_min", category: "Crypto", tags: ["BTC", "15 min"], settlement_sources: market.settlementSources },
            side: rule.side,
            contracts: size.contracts,
            overrideAskCents: size.askCents,
          },
          store
        );
        if (submitted.ok) {
          submitted.order.decisionId = rec.decisionId;
          rec.outcome = "PAPER_ORDER_RECORDED";
          rec.outcomeCode = "PAPER_ORDER_RECORDED";
          rec.outcomeMessage = `PAPER ${rule.side.toUpperCase()} x${size.contracts} @ ${submitted.order.effectiveFillCents}¢ (stake $${submitted.order.totalStakeDollars.toFixed(2)}, cap: ${size.capLabel} $${size.capDollars.toFixed(2)}).`;
          rec.orderId = submitted.order.orderId;
        } else {
          rec.outcome = "BLOCKED";
          rec.outcomeCode = submitted.code;
          rec.outcomeMessage = submitted.message;
        }
      }
    }
  } else if (mode === "evaluate-and-trade" && !rule.trade) {
    rec.outcome = "NO_TRADE_SIGNAL";
  }

  recordDecision(rec, store);

  return NextResponse.json({
    ok: true,
    mode,
    market: { ticker: market.ticker, title: market.title, openTime: market.openTime, closeTime: market.closeTime, status: market.status, secondsToClose: ctx.secondsToClose },
    contextErrors: ctx.errors,
    decision: rec,
    jev: { latencyMs: call.latencyMs, usage: call.usage, httpStatus: call.httpStatus },
    run: store.run,
    portfolio: computePaperPortfolioSummary(store),
    orders: store.orders,
    decisions: store.decisions,
  });
}
