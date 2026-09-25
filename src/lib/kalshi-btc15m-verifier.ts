// Read-only discovery and strict verification for Kalshi Bitcoin 15-minute Up/Down markets.
// Safety guarantees:
// - Uses unauthenticated public GET requests only (https://api.elections.kalshi.com/trade-api/v2).
// - Never guesses or hardcodes market ticker formats to accept markets.
// - Every candidate series & market is verified against 4 explicit gates:
//   1. Asset is Bitcoin (BTC) exclusively (rejects Bitcoin Cash/BCH, WBTC, ETH, SOL, indices, FX, etc.)
//   2. Market type is Up/Down directional comparison (rejects Above/Below strike ladders, ranges, highs/lows)
//   3. Time interval is exactly 15 minutes (series frequency === "fifteen_min" AND close_time - open_time === 900s)
//   4. Published rules & settlement source are present and verifiable (CF Benchmarks BRTI 60s average)

export const KALSHI_PUBLIC_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiSettlementSource {
  name?: string;
  url?: string;
}

export interface KalshiSeriesRaw {
  ticker?: string;
  title?: string;
  frequency?: string;
  category?: string;
  tags?: string[] | null;
  settlement_sources?: KalshiSettlementSource[] | null;
  contract_url?: string;
  contract_terms_url?: string;
}

export interface KalshiMarketRaw {
  ticker?: string;
  event_ticker?: string;
  series_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  market_type?: string;
  status?: string;
  open_time?: string;
  close_time?: string;
  expected_expiration_time?: string;
  expiration_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  rules_primary?: string;
  rules_secondary?: string;
  result?: string;
  expiration_value?: string;
  settlement_value_dollars?: string;
}

export interface GateCheck {
  passed: boolean;
  reason: string;
}

export interface MarketVerificationResult {
  inScope: boolean;
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  title: string;
  status: string;
  openTime: string | null;
  closeTime: string | null;
  intervalSeconds: number | null;
  intervalMinutes: number | null;
  yesBidCents: number | null;
  yesAskCents: number | null;
  noBidCents: number | null;
  noAskCents: number | null;
  lastPriceCents: number | null;
  targetPriceNote: string | null;
  rulesPrimary: string;
  rulesSecondary: string;
  settlementSources: KalshiSettlementSource[];
  checks: {
    assetIsBitcoinBtc: GateCheck;
    marketTypeIsUpDown: GateCheck;
    intervalIsFifteenMinutes: GateCheck;
    rulesAndSettlementVerified: GateCheck;
  };
  exclusionReasons: string[];
  settlement: {
    canClaimFinalOutcome: boolean;
    officialResult: "yes" | "no" | null;
    officialExpirationValue: string | null;
    explanation: string;
  };
}

// Explicit non-BTC asset keywords that must never pass as Bitcoin (BTC).
const NON_BTC_ASSET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bbitcoin\s*cash\b|\bbch\b|\bbchusd\b/i, label: "Bitcoin Cash (BCH)" },
  { pattern: /\bwrapped\s*bitcoin\b|\bwbtc\b/i, label: "Wrapped Bitcoin (WBTC)" },
  { pattern: /\bbitcoin\s*sv\b|\bbsv\b/i, label: "Bitcoin SV (BSV)" },
  { pattern: /\bethereum\b|\beth\b|\bethusd\b/i, label: "Ethereum (ETH)" },
  { pattern: /\bsolana\b|\bsol\b|\bsolusd\b/i, label: "Solana (SOL)" },
  { pattern: /\bdogecoin\b|\bdoge\b/i, label: "Dogecoin (DOGE)" },
  { pattern: /\bxrp\b|\bripple\b/i, label: "XRP" },
  { pattern: /\bcardano\b|\bada\b/i, label: "Cardano (ADA)" },
  { pattern: /\bzcash\b|\bzec\b/i, label: "Zcash (ZEC)" },
  { pattern: /\btoncoin\b|\bton\s*15/i, label: "TON" },
  { pattern: /\bnear\s*15|\bnear\s*protocol\b/i, label: "NEAR" },
  { pattern: /\bhype\b|\bhyperliquid\b/i, label: "HYPE" },
  { pattern: /\bnasdaq\b|\bndq\b|\bs&p\s*500\b|\binx\b/i, label: "Equity Index (Nasdaq / S&P 500)" },
  { pattern: /\btreasury\b|\byield\b|\busdjpy\b|\beurusd\b|\bgbpusd\b/i, label: "Rates / FX" },
  { pattern: /\bwti\b|\bpalladium\b|\bgold\b/i, label: "Commodity" },
  { pattern: /\bcoin\s*race\b|\bcrypto\s*comparison\b/i, label: "Multi-coin comparison" },
];

function dollarsToCents(val: string | undefined): number | null {
  if (!val) return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 100; // preserve deci-cent precision in cents
}

export function verifySeriesCandidate(series: KalshiSeriesRaw): {
  passed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const title = (series.title ?? "").trim();
  const freq = (series.frequency ?? "").trim().toLowerCase();
  const category = (series.category ?? "").trim().toLowerCase();
  const tags = Array.isArray(series.tags) ? series.tags.map((t) => String(t).toUpperCase()) : [];
  const combined = `${title} ${ tags.join(" ") }`;

  // 1. Reject any non-BTC lookalike or other asset first
  for (const Disallowed of NON_BTC_ASSET_PATTERNS) {
    if (Disallowed.pattern.test(combined)) {
      reasons.push(`Excluded asset: series "${title}" (${series.ticker ?? "unknown"}) references ${Disallowed.label}, not Bitcoin (BTC).`);
    }
  }

  // 2. Must positively identify Bitcoin / BTC
  const hasBtcTag = tags.includes("BTC");
  const hasBitcoinWord = /\bbitcoin\b|\bbtc\b/i.test(title) && !/\bbitcoin\s*cash\b/i.test(title);
  if (!hasBtcTag && !hasBitcoinWord) {
    reasons.push(`Excluded asset: series "${title}" (${series.ticker ?? "unknown"}) does not verify as Bitcoin (BTC).`);
  }

  if (category !== "crypto") {
    reasons.push(`Excluded category: series category is "${series.category ?? "unknown"}" (expected "Crypto").`);
  }

  // 3. Must be 15-minute frequency
  if (freq !== "fifteen_min") {
    reasons.push(`Excluded interval: series frequency is "${series.frequency ?? "unknown"}" (expected "fifteen_min").`);
  }

  // 4. Must be Up/Down market type at the series level
  const isUpDownTitle = /\bup\s*\/?\s*down\b|\bprice\s+up\s+down\b/i.test(title);
  if (!isUpDownTitle) {
    reasons.push(`Excluded market type: series title "${title}" does not state an Up/Down contract (e.g. Above/Below, range, or generic series).`);
  }

  // 5. Settlement sources must be declared
  const sources = Array.isArray(series.settlement_sources) ? series.settlement_sources : [];
  if (sources.length === 0) {
    reasons.push(`Excluded settlement: series "${series.ticker ?? "unknown"}" has no published settlement_sources.`);
  }

  return { passed: reasons.length === 0, reasons };
}

export function verifyKalshiMarket(
  market: KalshiMarketRaw,
  series?: KalshiSeriesRaw | null
): MarketVerificationResult {
  const ticker = String(market.ticker ?? "");
  const eventTicker = String(market.event_ticker ?? "");
  const seriesTicker = String(market.series_ticker ?? series?.ticker ?? "");
  const title = String(market.title ?? "").trim();
  const rulesPrimary = String(market.rules_primary ?? "").trim();
  const rulesSecondary = String(market.rules_secondary ?? "").trim();
  const status = String(market.status ?? "unknown");
  const settlementSources = Array.isArray(series?.settlement_sources)
    ? series!.settlement_sources!
    : [];

  // ---- Gate 1: Asset is Bitcoin (BTC) exclusively ----
  const combinedText = `${series?.title ?? ""} ${title} ${rulesPrimary}`;
  let nonBtcHit: string | null = null;
  for (const item of NON_BTC_ASSET_PATTERNS) {
    if (item.pattern.test(combinedText)) {
      nonBtcHit = item.label;
      break;
    }
  }
  const mentionsBtc =
    (/\bbitcoin\b|\bbtc\b/i.test(title) || /\bbitcoin\b|\bbtc\b/i.test(series?.title ?? "")) &&
    !/\bbitcoin\s*cash\b/i.test(combinedText);
  const mentionsBrti = /\bCF\s+Benchmarks'\s+BRTI\b/i.test(rulesPrimary);

  let assetCheck: GateCheck;
  if (nonBtcHit) {
    assetCheck = {
      passed: false,
      reason: `Rejected non-BTC asset: detected ${nonBtcHit} in market/series metadata.`,
    };
  } else if (!mentionsBtc || !mentionsBrti) {
    assetCheck = {
      passed: false,
      reason: !mentionsBtc
        ? `Market title "${title}" does not explicitly identify Bitcoin (BTC).`
        : `Market primary rules do not reference CF Benchmarks' BRTI (Bitcoin Real Time Index).`,
    };
  } else {
    assetCheck = {
      passed: true,
      reason: `Verified Bitcoin (BTC) via market title ("${title}") and CF Benchmarks' BRTI settlement index in rules_primary.`,
    };
  }

  // ---- Gate 2: Market Type is Up/Down exclusively ----
  const isBinary = String(market.market_type ?? "").toLowerCase() === "binary";
  const titleUpDown =
    /\bprice\s+up\s+in\s+next\s+15\s+mins\??/i.test(title) ||
    /\bup\s*\/?\s*down\b/i.test(title) ||
    /\bup\s+down\b/i.test(series?.title ?? "");
  const rulesCompareWindowStartEnd =
    /simple average of the sixty seconds of CF Benchmarks' BRTI before .+ is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before .+, then the market resolves to Yes/i.test(
      rulesPrimary
    );
  const isStrikeLadder = /\babove\/below\b|\bmin\/max\b|\bhit\s+\$?\d/i.test(combinedText);

  let typeCheck: GateCheck;
  if (!isBinary) {
    typeCheck = {
      passed: false,
      reason: `Market type is "${market.market_type ?? "unknown"}" (must be binary Up/Down).`,
    };
  } else if (isStrikeLadder) {
    typeCheck = {
      passed: false,
      reason: `Market is a fixed-strike Above/Below or range contract, not an interval Up/Down market.`,
    };
  } else if (!titleUpDown || !rulesCompareWindowStartEnd) {
    typeCheck = {
      passed: false,
      reason: `Market rules/title do not verify as an Up/Down interval comparison (start-of-window BRTI vs end-of-window BRTI).`,
    };
  } else {
    typeCheck = {
      passed: true,
      reason: `Verified binary Up/Down contract comparing 60-second BRTI average at interval close vs. interval open.`,
    };
  }

  // ---- Gate 3: Time Interval is 15-minute (900 seconds) exclusively ----
  const openMs = market.open_time ? Date.parse(market.open_time) : NaN;
  const closeMs = market.close_time ? Date.parse(market.close_time) : NaN;
  const hasValidTimestamps = Number.isFinite(openMs) && Number.isFinite(closeMs) && closeMs > openMs;
  const intervalSeconds = hasValidTimestamps ? Math.round((closeMs - openMs) / 1000) : null;
  const intervalMinutes = intervalSeconds !== null ? intervalSeconds / 60 : null;
  const seriesFreqOk = !series?.frequency || series.frequency === "fifteen_min";

  let intervalCheck: GateCheck;
  if (!hasValidTimestamps || intervalSeconds === null) {
    intervalCheck = {
      passed: false,
      reason: `Missing or invalid open_time (${market.open_time ?? "null"}) / close_time (${market.close_time ?? "null"}); cannot verify 15-minute window.`,
    };
  } else if (intervalSeconds !== 900) {
    intervalCheck = {
      passed: false,
      reason: `Market interval (close_time - open_time) is ${intervalMinutes} minutes (${intervalSeconds}s), not 15 minutes (900s).`,
    };
  } else if (!seriesFreqOk) {
    intervalCheck = {
      passed: false,
      reason: `Series frequency is "${series?.frequency}", not "fifteen_min".`,
    };
  } else {
    intervalCheck = {
      passed: true,
      reason: `Verified exact 15-minute (900s) window from ${market.open_time} to ${market.close_time}.`,
    };
  }

  // ---- Gate 4: Published Rules & Settlement Source Verified ----
  const hasPrimaryRules = rulesPrimary.length > 30 && mentionsBrti;
  const hasSecondaryRules = /Real Time Index \(RTI\)/i.test(rulesSecondary);
  const hasCfBenchmarksSource =
    settlementSources.length === 0
      ? mentionsBrti
      : settlementSources.some((s) => /CF\s*Benchmarks/i.test(String(s.name ?? "")));

  let rulesCheck: GateCheck;
  if (!hasPrimaryRules || !hasCfBenchmarksSource) {
    rulesCheck = {
      passed: false,
      reason: `Published settlement rules or CF Benchmarks BRTI settlement source could not be verified.`,
    };
  } else {
    rulesCheck = {
      passed: true,
      reason: `Verified published rules & settlement source: CF Benchmarks BRTI (60-second simple average, rounded to 2 decimal places)${hasSecondaryRules ? " with secondary RTI specification" : ""}.`,
    };
  }

  const checks = {
    assetIsBitcoinBtc: assetCheck,
    marketTypeIsUpDown: typeCheck,
    intervalIsFifteenMinutes: intervalCheck,
    rulesAndSettlementVerified: rulesCheck,
  };

  const exclusionReasons = Object.values(checks)
    .filter((c) => !c.passed)
    .map((c) => c.reason);

  const inScope = exclusionReasons.length === 0;

  // ---- Settlement Outcome Verification ----
  // Only claim a final outcome if the market is in scope, rules are verified,
  // Kalshi status is finalized/settled, and official result ("yes" | "no") is published.
  const rawResult = String(market.result ?? "").toLowerCase();
  const isFinalized = status === "finalized" || status === "settled";
  const hasOfficialBinaryResult = rawResult === "yes" || rawResult === "no";
  const expVal = market.expiration_value ? String(market.expiration_value).trim() : null;

  const canClaimFinalOutcome =
    inScope && rulesCheck.passed && isFinalized && hasOfficialBinaryResult && Boolean(expVal);

  const settlement = canClaimFinalOutcome
    ? {
        canClaimFinalOutcome: true,
        officialResult: rawResult as "yes" | "no",
        officialExpirationValue: expVal,
        explanation: `Official Kalshi settlement verified via CF Benchmarks BRTI: status="${status}", result="${rawResult.toUpperCase()}", expiration_value="${expVal}".`,
      }
    : {
        canClaimFinalOutcome: false,
        officialResult: null,
        officialExpirationValue: expVal,
        explanation: !inScope
          ? "Market is out of scope; outcome cannot be evaluated."
          : !isFinalized
          ? `Market status is "${status}" (not finalized). Per simulator safety rules, no final result is calculated or claimed until official CF Benchmarks BRTI settlement is finalized.`
          : `Official settlement result or expiration_value is incomplete; refusing to guess or claim a final outcome.`,
      };

  return {
    inScope,
    ticker,
    eventTicker,
    seriesTicker,
    title,
    status,
    openTime: market.open_time ?? null,
    closeTime: market.close_time ?? null,
    intervalSeconds,
    intervalMinutes,
    yesBidCents: dollarsToCents(market.yes_bid_dollars),
    yesAskCents: dollarsToCents(market.yes_ask_dollars),
    noBidCents: dollarsToCents(market.no_bid_dollars),
    noAskCents: dollarsToCents(market.no_ask_dollars),
    lastPriceCents: dollarsToCents(market.last_price_dollars),
    targetPriceNote: market.yes_sub_title ?? null,
    rulesPrimary,
    rulesSecondary,
    settlementSources,
    checks,
    exclusionReasons,
    settlement,
  };
}

export interface DiscoveryReport {
  discoveredAt: string;
  sourceEndpoint: string;
  readOnly: true;
  totalSeriesInspected: number;
  inScopeSeriesTickers: string[];
  verifiedMarkets: MarketVerificationResult[];
  excludedExamples: Array<{
    ticker: string;
    seriesTicker: string;
    title: string;
    frequency: string;
    category: string;
    reasons: string[];
  }>;
  fetchError: string | null;
}

// Live read-only discovery against Kalshi's public v2 endpoints.
export async function discoverLiveKalshiBtc15mMarkets(): Promise<DiscoveryReport> {
  const discoveredAt = new Date().toISOString();
  try {
    const seriesRes = await fetch(`${KALSHI_PUBLIC_API_BASE}/series`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!seriesRes.ok) {
      throw new Error(`Kalshi /series returned HTTP ${seriesRes.status}`);
    }
    const seriesJson = (await seriesRes.json()) as { series?: KalshiSeriesRaw[] };
    const allSeries = Array.isArray(seriesJson.series) ? seriesJson.series : [];

    const inScopeSeries: KalshiSeriesRaw[] = [];
    const excludedExamples: DiscoveryReport["excludedExamples"] = [];

    // Inspect every series dynamically (no hardcoded ticker whitelist).
    for (const s of allSeries) {
      const check = verifySeriesCandidate(s);
      if (check.passed && s.ticker) {
        inScopeSeries.push(s);
      } else {
        // Collect notable near-miss series (e.g., 15-min non-BTC or BTC non-15-min) as transparent audit proof.
        const t = `${s.title ?? ""} ${s.ticker ?? ""}`.toLowerCase();
        const isInterestingNearMiss =
          s.frequency === "fifteen_min" ||
          t.includes("bitcoin") ||
          t.includes("btc") ||
          t.includes("eth") ||
          t.includes("sol");
        if (isInterestingNearMiss && excludedExamples.length < 14) {
          excludedExamples.push({
            ticker: String(s.ticker ?? ""),
            seriesTicker: String(s.ticker ?? ""),
            title: String(s.title ?? ""),
            frequency: String(s.frequency ?? ""),
            category: String(s.category ?? ""),
            reasons: check.reasons,
          });
        }
      }
    }

    const verifiedMarkets: MarketVerificationResult[] = [];

    for (const series of inScopeSeries) {
      const sTicker = encodeURIComponent(String(series.ticker));
      // Fetch open/active markets and recently settled markets for this discovered series
      const [openRes, settledRes, initRes] = await Promise.all([
        fetch(`${KALSHI_PUBLIC_API_BASE}/markets?series_ticker=${sTicker}&status=open&limit=10`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }),
        fetch(`${KALSHI_PUBLIC_API_BASE}/markets?series_ticker=${sTicker}&status=settled&limit=6`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }),
        fetch(`${KALSHI_PUBLIC_API_BASE}/markets?series_ticker=${sTicker}&limit=6`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }),
      ]);

      const rawMarkets: KalshiMarketRaw[] = [];
      for (const r of [openRes, settledRes, initRes]) {
        if (r.ok) {
          const j = (await r.json()) as { markets?: KalshiMarketRaw[] };
          if (Array.isArray(j.markets)) rawMarkets.push(...j.markets);
        }
      }

      const seen = new Set<string>();
      for (const m of rawMarkets) {
        const mTicker = String(m.ticker ?? "");
        if (!mTicker || seen.has(mTicker)) continue;
        seen.add(mTicker);

        const verified = verifyKalshiMarket(
          { ...m, series_ticker: series.ticker },
          series
        );
        if (verified.inScope) {
          verifiedMarkets.push(verified);
        } else {
          excludedExamples.push({
            ticker: verified.ticker,
            seriesTicker: String(series.ticker ?? ""),
            title: verified.title,
            frequency: String(series.frequency ?? ""),
            category: String(series.category ?? ""),
            reasons: verified.exclusionReasons,
          });
        }
      }
    }

    // Sort: active/open first, then initialized, then finalized/settled by closeTime desc
    verifiedMarkets.sort((a, b) => {
      const rank = (s: string) => (s === "active" || s === "open" ? 0 : s === "initialized" ? 1 : 2);
      const rDiff = rank(a.status) - rank(b.status);
      if (rDiff !== 0) return rDiff;
      return String(b.closeTime ?? "").localeCompare(String(a.closeTime ?? ""));
    });

    return {
      discoveredAt,
      sourceEndpoint: `${KALSHI_PUBLIC_API_BASE}/series + /markets`,
      readOnly: true,
      totalSeriesInspected: allSeries.length,
      inScopeSeriesTickers: inScopeSeries.map((s) => String(s.ticker)),
      verifiedMarkets,
      excludedExamples,
      fetchError: null,
    };
  } catch (e) {
    return {
      discoveredAt,
      sourceEndpoint: `${KALSHI_PUBLIC_API_BASE}/series + /markets`,
      readOnly: true,
      totalSeriesInspected: 0,
      inScopeSeriesTickers: [],
      verifiedMarkets: [],
      excludedExamples: [],
      fetchError: e instanceof Error ? e.message : "Failed to query Kalshi public read-only API.",
    };
  }
}
