// Read-only market context for the decision engine.
// All requests are unauthenticated public GETs against Kalshi's v2 API.
// No order, portfolio, or account endpoints are ever touched.

import { KALSHI_PUBLIC_API_BASE, type MarketVerificationResult } from "@/lib/kalshi-btc15m-verifier";

export interface PriceContext {
  ticker: string;
  fetchedAt: string;
  yesBidCents: number | null;
  yesAskCents: number | null;
  noBidCents: number | null;
  noAskCents: number | null;
  lastPriceCents: number | null;
  volume: string | null;
  openInterest: string | null;
  orderbookYesBids: Array<{ priceCents: number; size: number }>;
  orderbookNoBids: Array<{ priceCents: number; size: number }>;
  recentTrades: Array<{ time: string; takerSide: string; count: number; yesPriceCents: number }>;
  recentOutcomes: Array<{ ticker: string; result: string; expirationValue: string; closeTime: string }>;
  secondsToClose: number | null;
  errors: string[];
}

const toCents = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 100 : null;
};

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.replace(KALSHI_PUBLIC_API_BASE, "")}`);
  return res.json();
}

export async function fetchPriceContext(market: MarketVerificationResult): Promise<PriceContext> {
  const ctx: PriceContext = {
    ticker: market.ticker,
    fetchedAt: new Date().toISOString(),
    yesBidCents: market.yesBidCents,
    yesAskCents: market.yesAskCents,
    noBidCents: market.noBidCents,
    noAskCents: market.noAskCents,
    lastPriceCents: market.lastPriceCents,
    volume: null,
    openInterest: null,
    orderbookYesBids: [],
    orderbookNoBids: [],
    recentTrades: [],
    recentOutcomes: [],
    secondsToClose: market.closeTime ? Math.round((Date.parse(market.closeTime) - Date.now()) / 1000) : null,
    errors: [],
  };

  const t = encodeURIComponent(market.ticker);
  const s = encodeURIComponent(market.seriesTicker || "KXBTC15M");

  const [fresh, ob, tr, settled] = await Promise.allSettled([
    getJson(`${KALSHI_PUBLIC_API_BASE}/markets/${t}`),
    getJson(`${KALSHI_PUBLIC_API_BASE}/markets/${t}/orderbook?depth=5`),
    getJson(`${KALSHI_PUBLIC_API_BASE}/markets/trades?ticker=${t}&limit=10`),
    getJson(`${KALSHI_PUBLIC_API_BASE}/markets?series_ticker=${s}&status=settled&limit=8`),
  ]);

  // Fresh quote (the discovery snapshot may be a few seconds old)
  if (fresh.status === "fulfilled") {
    const m = (fresh.value as { market?: Record<string, unknown> })?.market ?? {};
    ctx.yesBidCents = toCents(m.yes_bid_dollars) ?? ctx.yesBidCents;
    ctx.yesAskCents = toCents(m.yes_ask_dollars) ?? ctx.yesAskCents;
    ctx.noBidCents = toCents(m.no_bid_dollars) ?? ctx.noBidCents;
    ctx.noAskCents = toCents(m.no_ask_dollars) ?? ctx.noAskCents;
    ctx.lastPriceCents = toCents(m.last_price_dollars) ?? ctx.lastPriceCents;
    ctx.volume = typeof m.volume_fp === "string" ? m.volume_fp : ctx.volume;
    ctx.openInterest = typeof m.open_interest_fp === "string" ? m.open_interest_fp : ctx.openInterest;
  } else {
    ctx.errors.push(`quote: ${fresh.reason instanceof Error ? fresh.reason.message : String(fresh.reason)}`);
  }

  // Orderbook: orderbook_fp.yes_dollars / no_dollars are arrays of [price, size] — both are BIDS on their side.
  if (ob.status === "fulfilled") {
    const book = (ob.value as { orderbook_fp?: { yes_dollars?: unknown; no_dollars?: unknown } })?.orderbook_fp ?? {};
    const parse = (arr: unknown) =>
      Array.isArray(arr)
        ? arr
            .map((lvl) => (Array.isArray(lvl) ? { priceCents: toCents(lvl[0]), size: Number(lvl[1]) } : null))
            .filter((x): x is { priceCents: number; size: number } => x !== null && x.priceCents !== null && Number.isFinite(x.size))
            .sort((a, b) => b.priceCents - a.priceCents)
        : [];
    ctx.orderbookYesBids = parse(book.yes_dollars);
    ctx.orderbookNoBids = parse(book.no_dollars);
  } else {
    ctx.errors.push(`orderbook: ${ob.reason instanceof Error ? ob.reason.message : String(ob.reason)}`);
  }

  if (tr.status === "fulfilled") {
    const trades = (tr.value as { trades?: Array<Record<string, unknown>> })?.trades ?? [];
    ctx.recentTrades = trades
      .map((x) => ({
        time: String(x.created_time ?? ""),
        takerSide: String(x.taker_side ?? x.taker_outcome_side ?? "?"),
        count: Number(x.count_fp ?? x.count ?? 0),
        yesPriceCents: toCents(x.yes_price_dollars) ?? 0,
      }))
      .filter((x) => x.count > 0);
  } else {
    ctx.errors.push(`trades: ${tr.reason instanceof Error ? tr.reason.message : String(tr.reason)}`);
  }

  if (settled.status === "fulfilled") {
    const ms = (settled.value as { markets?: Array<Record<string, unknown>> })?.markets ?? [];
    ctx.recentOutcomes = ms
      .filter((m) => m.result === "yes" || m.result === "no")
      .map((m) => ({
        ticker: String(m.ticker ?? ""),
        result: String(m.result),
        expirationValue: String(m.expiration_value ?? ""),
        closeTime: String(m.close_time ?? ""),
      }));
  } else {
    ctx.errors.push(`settled: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
  }

  return ctx;
}
