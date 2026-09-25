// Jev decision engine — TypeScript port of bot/jev_decision.py (V3 fixed logic)
// merged into the fuller V1 dashboard architecture (price context + auto-trade).
//
// Batched three-question call to TypeSafe's System One API (Jev):
//   - direction    (choice): up / down / pass
//   - conviction   (score):  0=none, 1=low, 2=medium, 3=high
//   - should_trade (noul):   probability that we should paper-trade
//
// Safety:
//   - JEV_API_KEY is read from process.env on the server only. Never sent to the browser,
//     never logged, never echoed back in any API response.
//   - This module produces a SIGNAL only. It cannot place orders. Any paper order still has
//     to pass every gate in paper-simulator-store.submitPaperOrder().
//   - Zero free-text generation is requested; Jev returns typed probabilities only.
//
// Fixes ported from bot/jev_decision.py (each reproduced against the original):
//   A. direction="pass" + noul>0.5 no longer yields shouldTrade=true (fail closed).
//   B. Invalid/missing direction or conviction no longer yields shouldTrade=true.
//   C. conviction=0 ("No signal") never trades (MIN_CONVICTION_TO_TRADE = 1).
//   D. Mid uses YES bid/ask (not (yes+no)/2 which is always ~0.50).
//   E. Order-book best is max price (handled in kalshi-market-context).
//   F. Removed undocumented request fields ("options" on choice).
//   G. Rules: YES if close BRTI average is AT LEAST the target (ties resolve YES).
//   H. No free-text "response format" block in state.
//   I. bool checked before int/float (bool is a subclass of int in Python).
//   J. Conviction uses floor(score + 0.5), not banker's round().

import type { MarketVerificationResult } from "@/lib/kalshi-btc15m-verifier";
import type { PriceContext } from "@/lib/kalshi-market-context";

export const JEV_DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 30_000;

/** User's original threshold — kept unchanged. */
export const SHOULD_TRADE_NOUL_THRESHOLD = 0.5;
/**
 * User's rubric defines level 0 as "No signal or conflicting indicators".
 * Trading on "no signal" contradicts the rubric, so level 0 never trades.
 */
export const MIN_CONVICTION_TO_TRADE = 1;

export type Direction = "up" | "down" | "pass";

export interface DecisionResult {
  direction: Direction;
  conviction: number; // 0..3
  shouldTrade: boolean;
  rawResponse: string;
  parseErrors: string[];
  /** Explicit reasons shouldTrade was forced false (fail-closed reconciliation). */
  vetoReasons: string[];
  reasoning: string; // probabilities summary (Jev emits no prose)
  valid: boolean;
  summary: string;
  probabilities: {
    direction: Record<string, number> | null;
    conviction: Record<string, number> | null;
    convictionScoreRaw: number | null;
    shouldTradeNoul: number | null;
    directionConfidence: number | null;
    convictionConfidence: number | null;
  };
}

export function jevApiUrl(): string {
  return (process.env.JEV_API_URL || JEV_DEFAULT_API_URL).trim();
}

export function isJevConfigured(): boolean {
  return Boolean(
    (process.env.JEV_API_KEY && process.env.JEV_API_KEY.trim().length > 0) ||
      (process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim().length > 0)
  );
}

export function jevStatusForDisplay() {
  let host = "(invalid url)";
  try {
    host = new URL(jevApiUrl()).host;
  } catch {
    /* ignore */
  }
  return {
    engine: "Jev (TypeSafe System One)",
    model: JEV_MODEL,
    apiHost: host,
    configured: isJevConfigured(),
    keySource:
      "process.env.JEV_API_KEY (server-side only; configure via the platform secret manager — never paste the key in chat)",
    producesText: false,
    canPlaceOrders: false,
    minConvictionToTrade: MIN_CONVICTION_TO_TRADE,
    shouldTradeNoulThreshold: SHOULD_TRADE_NOUL_THRESHOLD,
  };
}

// ── Prompt template (port of _build_state / _build_prompt, with live market rules) ──

function cents(v: number | null | undefined): string {
  return v === null || v === undefined ? "n/a" : `${v.toFixed(1)}¢ ($${(v / 100).toFixed(4)})`;
}

export function buildPrompt(market: MarketVerificationResult, ctx: PriceContext): string {
  const yesAsk = ctx.yesAskCents ?? market.yesAskCents;
  const noAsk = ctx.noAskCents ?? market.noAskCents;
  const yesBid = ctx.yesBidCents ?? market.yesBidCents;
  const noBid = ctx.noBidCents ?? market.noBidCents;
  const last = ctx.lastPriceCents ?? market.lastPriceCents;
  // Fix D: mid from YES bid/ask only — (yes+no)/2 is always ~50¢ on a binary market.
  const impliedYes =
    yesAsk !== null && yesBid !== null
      ? (yesAsk + yesBid) / 2
      : yesAsk ?? yesBid;

  const marketLines = [
    `Series: ${market.seriesTicker}  Event: ${market.eventTicker}  Market: ${market.ticker}`,
    `Title: ${market.title}`,
    `Window (UTC): ${market.openTime} -> ${market.closeTime} (${market.intervalMinutes} minutes)`,
    `Time remaining to window close: ${ctx.secondsToClose === null ? "n/a" : `${Math.max(0, ctx.secondsToClose)} seconds`}`,
    `Reference / Target Price (60s BRTI average at window open): ${market.targetPriceNote ?? "n/a"}`,
    `Status: ${market.status}`,
  ];

  const priceLines = [
    `YES bid: ${cents(yesBid)}   YES ask: ${cents(yesAsk)}`,
    `NO  bid: ${cents(noBid)}   NO  ask: ${cents(noAsk)}`,
    `Last trade price (YES): ${cents(last)}`,
    `Implied probability of YES (mid of YES bid/ask): ${impliedYes === null || impliedYes === undefined ? "n/a" : `${impliedYes.toFixed(1)}%`}`,
    `Volume: ${ctx.volume ?? "n/a"}   Open interest: ${ctx.openInterest ?? "n/a"}`,
  ];

  if (ctx.orderbookYesBids.length) {
    priceLines.push(
      `YES bids (top ${ctx.orderbookYesBids.length}): ` +
        ctx.orderbookYesBids.map((l) => `${l.size.toFixed(0)} @ ${l.priceCents.toFixed(1)}¢`).join(", ")
    );
  }
  if (ctx.orderbookNoBids.length) {
    priceLines.push(
      `NO bids (top ${ctx.orderbookNoBids.length}): ` +
        ctx.orderbookNoBids.map((l) => `${l.size.toFixed(0)} @ ${l.priceCents.toFixed(1)}¢`).join(", ")
    );
  }
  if (ctx.recentTrades.length) {
    priceLines.push(
      `Recent trades (newest first): ` +
        ctx.recentTrades
          .slice(0, 8)
          .map((t) => `${t.takerSide.toUpperCase()} ${t.count.toFixed(0)} @ YES ${t.yesPriceCents.toFixed(1)}¢`)
          .join("; ")
    );
  }

  const outcomeLines = ctx.recentOutcomes.length
    ? ctx.recentOutcomes.map((o) => `${o.closeTime} ${o.ticker}: ${o.result.toUpperCase()} (BRTI ${o.expirationValue})`)
    : ["(no settled history available)"];

  // Fix G: ties resolve YES (close BRTI average AT LEAST the target).
  return (
    "You are evaluating a single Kalshi BTC 15-minute Up/Down contract for PAPER trading advice only.\n\n" +
    "=== MARKET ===\n" +
    marketLines.join("\n") +
    "\n\n=== PRICES (read-only public data) ===\n" +
    priceLines.join("\n") +
    "\n\n=== RECENT SETTLED OUTCOMES (same series) ===\n" +
    outcomeLines.join("\n") +
    "\n\n=== RULES ===\n" +
    "- Contract settles YES if the 60-second CF Benchmarks BRTI average at window close is AT LEAST the Target Price (ties resolve YES).\n" +
    "- Contract settles NO if that average is strictly BELOW the Target Price.\n" +
    "- 'up' means buy YES at the YES ask; 'down' means buy NO at the NO ask. A correct contract pays $1.00, an incorrect one pays $0.\n" +
    "- The YES price is the market-implied probability of YES (50¢ = 50%).\n" +
    "- Settlement source: CF Benchmarks BRTI (not Coinbase, not Google).\n\n" +
    "Answer all three questions: direction (up/down/pass), conviction (none/low/medium/high), and whether a paper trade should be executed."
  );
}

// ── Payload (Fix F: no undocumented "options" / "levels" fields) ──

export function buildJevPayload(prompt: string) {
  return {
    model: JEV_MODEL,
    state: prompt,
    questions: {
      direction: {
        type: "choice",
        instructions:
          "Which outcome of this Kalshi BTC 15-minute up/down window is more likely, or is there too little signal to act?",
        criteria: {
          up: "The 60s BRTI average at close will be at least the target price (contract resolves YES)",
          down: "The 60s BRTI average at close will be below the target price (contract resolves NO)",
          pass: "Not enough signal to prefer either side at the current prices",
        },
      },
      conviction: {
        type: "score",
        instructions: "How strong is the evidence in the state for a directional view?",
        criteria: [
          "No signal or conflicting indicators",
          "Weak directional bias, low confidence",
          "Moderate confidence in predicted direction",
          "Strong conviction in predicted direction",
        ],
      },
      should_trade: {
        type: "noul",
        instructions:
          "Buying a contract at the current ask has positive expected value given the evidence in the state.",
      },
    },
  };
}

export type JevCallResult =
  | { ok: true; answers: Record<string, unknown>; usage: unknown; httpStatus: number; latencyMs: number }
  | { ok: false; code: string; message: string; httpStatus: number | null; latencyMs: number };

// ── API call ──
export async function callJev(payload: ReturnType<typeof buildJevPayload>): Promise<JevCallResult> {
  const started = Date.now();
  const key = (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || "").trim();
  if (!key) {
    return {
      ok: false,
      code: "JEV_NOT_CONFIGURED",
      message:
        "JEV_API_KEY is not configured on the server. Add it through the platform's secure secret manager (do not paste it in chat). No decision was requested and no trade will be made.",
      httpStatus: null,
      latencyMs: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetch(jevApiUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        code: "JEV_NON_JSON",
        message: `Jev API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        httpStatus: res.status,
        latencyMs,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        code: "JEV_HTTP_ERROR",
        message: `Jev API HTTP ${res.status}: ${text.slice(0, 200)}`,
        httpStatus: res.status,
        latencyMs,
      };
    }
    const answers = (data as { answers?: unknown } | null)?.answers;
    if (!answers || typeof answers !== "object") {
      return {
        ok: false,
        code: "JEV_NO_ANSWERS",
        message: `Jev response has no 'answers' key: ${text.slice(0, 200)}`,
        httpStatus: res.status,
        latencyMs,
      };
    }
    return {
      ok: true,
      answers: answers as Record<string, unknown>,
      usage: (data as { usage?: unknown }).usage ?? null,
      httpStatus: res.status,
      latencyMs,
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    if (e instanceof Error && e.name === "AbortError") {
      return {
        ok: false,
        code: "JEV_TIMEOUT",
        message: `Jev API timeout (${JEV_TIMEOUT_MS / 1000}s)`,
        httpStatus: null,
        latencyMs,
      };
    }
    return {
      ok: false,
      code: "JEV_REQUEST_ERROR",
      message: `Jev API request error: ${e instanceof Error ? e.message : String(e)}`,
      httpStatus: null,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Parser (port of _parse_jev_response with fail-closed reconciliation) ──

/**
 * Half-up rounding: floor(x + 0.5).
 * Fix J: replaces Python's banker's round() so round(2.5) === 3, not 2.
 * Kept exported as `pythonRound` for call-site compatibility; behavior matches the fixed Python module.
 */
export function pythonRound(x: number): number {
  return Math.floor(x + 0.5);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown): number | null {
  // Fix I: bool checked before number (in Python bool is a subclass of int)
  if (typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function parseJevResponse(raw: unknown): DecisionResult {
  const result: DecisionResult = {
    direction: "pass",
    conviction: 0,
    shouldTrade: false,
    rawResponse: "",
    parseErrors: [],
    vetoReasons: [],
    reasoning: "",
    valid: false,
    summary: "",
    probabilities: {
      direction: null,
      conviction: null,
      convictionScoreRaw: null,
      shouldTradeNoul: null,
      directionConfidence: null,
      convictionConfidence: null,
    },
  };

  if (raw === null || raw === undefined) {
    result.parseErrors.push("No response from Jev API");
    result.vetoReasons.push("1 parse error(s)");
    result.summary = "NO TRADE (direction=pass, conviction=0) — 1 parse error(s)";
    return result;
  }

  result.rawResponse = JSON.stringify(raw);
  const r = isObj(raw) ? raw : {};

  // direction (choice)
  const directionData = r.direction;
  if (isObj(directionData)) {
    const choice = directionData.choice;
    if (typeof choice === "string") {
      const c = choice.trim().toLowerCase();
      if (c === "up" || c === "down" || c === "pass") result.direction = c;
      else result.parseErrors.push(`Invalid direction value: ${c}`);
    } else if (choice !== null && choice !== undefined) {
      result.parseErrors.push(`Non-string direction: ${String(choice)}`);
    } else {
      result.parseErrors.push("No 'choice' key in direction response");
    }
    if (isObj(directionData.probabilities)) {
      result.probabilities.direction = Object.fromEntries(
        Object.entries(directionData.probabilities).map(([k, v]) => [k, Number(v)])
      );
    }
    if (typeof directionData.confidence === "number") {
      result.probabilities.directionConfidence = directionData.confidence;
    }
  } else {
    result.parseErrors.push(`Unexpected direction format: ${JSON.stringify(directionData)}`);
  }

  // conviction (score) — Fix J: floor(score + 0.5)
  const convictionData = r.conviction;
  if (isObj(convictionData)) {
    const score = convictionData.score;
    const s = num(score);
    if (s !== null) {
      result.probabilities.convictionScoreRaw = s;
      result.conviction = Math.max(0, Math.min(3, pythonRound(s)));
    } else if (score !== null && score !== undefined) {
      result.parseErrors.push(`Non-numeric conviction score: ${String(score)}`);
    } else {
      result.parseErrors.push("No 'score' key in conviction response");
    }
    if (isObj(convictionData.probabilities)) {
      result.probabilities.conviction = Object.fromEntries(
        Object.entries(convictionData.probabilities).map(([k, v]) => [k, Number(v)])
      );
    }
    if (typeof convictionData.confidence === "number") {
      result.probabilities.convictionConfidence = convictionData.confidence;
    }
  } else {
    result.parseErrors.push(`Unexpected conviction format: ${JSON.stringify(convictionData)}`);
  }

  // should_trade (noul) — Fix I: bool before number
  const tradeData = r.should_trade;
  let noulSaysTrade = false;
  if (isObj(tradeData)) {
    const noul = tradeData.noul;
    if (typeof noul === "boolean") {
      result.probabilities.shouldTradeNoul = noul ? 1 : 0;
      noulSaysTrade = noul;
    } else {
      const n = num(noul);
      if (n !== null && n >= 0 && n <= 1) {
        result.probabilities.shouldTradeNoul = n;
        noulSaysTrade = n > SHOULD_TRADE_NOUL_THRESHOLD;
      } else if (noul !== null && noul !== undefined) {
        result.parseErrors.push(`Invalid or missing noul value: ${String(noul)}`);
      } else {
        result.parseErrors.push("No 'noul' key in should_trade response");
      }
    }
  } else {
    result.parseErrors.push(`Unexpected should_trade format: ${JSON.stringify(tradeData)}`);
  }

  // reasoning string from probabilities (Jev emits no prose)
  const parts: string[] = [];
  for (const key of ["direction", "conviction", "should_trade"] as const) {
    const entry = r[key];
    if (isObj(entry)) {
      if ("probabilities" in entry) parts.push(`${key}=${JSON.stringify(entry.probabilities)}`);
      else if (typeof entry.noul === "number") parts.push(`${key}=${entry.noul.toFixed(2)}`);
      else if (typeof entry.noul === "boolean") parts.push(`${key}=${entry.noul ? "1.00" : "0.00"}`);
      else if (typeof entry.score === "number") parts.push(`${key}=${entry.score.toFixed(2)}`);
    }
  }
  result.reasoning = parts.join("; ");

  // ── Reconcile the three independent answers (fail closed) — Fixes A, B, C ──
  if (result.parseErrors.length) {
    result.vetoReasons.push(`${result.parseErrors.length} parse error(s)`);
  }
  if (result.direction === "pass") {
    result.vetoReasons.push("direction is pass");
  }
  if (result.conviction < MIN_CONVICTION_TO_TRADE) {
    result.vetoReasons.push(
      `conviction ${result.conviction} < ${MIN_CONVICTION_TO_TRADE} (no signal)`
    );
  }
  if (!noulSaysTrade) {
    result.vetoReasons.push(
      `should_trade probability ${result.probabilities.shouldTradeNoul ?? "n/a"} <= ${SHOULD_TRADE_NOUL_THRESHOLD}`
    );
  }

  result.shouldTrade = noulSaysTrade && result.vetoReasons.length === 0;
  result.valid =
    ["up", "down", "pass"].includes(result.direction) &&
    result.conviction >= 0 &&
    result.conviction <= 3 &&
    result.parseErrors.length === 0;

  result.summary = result.shouldTrade
    ? `${result.direction.toUpperCase()} → PAPER ${result.direction === "up" ? "YES" : "NO"} (conviction=${result.conviction})`
    : `NO TRADE (direction=${result.direction}, conviction=${result.conviction}) — ${result.vetoReasons.join("; ")}`;

  return result;
}

// ── Strategy rule: configurable minConviction on top of the fail-closed parser ──
export interface StrategyRuleOutcome {
  trade: boolean;
  side: "yes" | "no" | null;
  reason: string;
  rule: string;
}

export function applyStrategyRule(decision: DecisionResult, minConviction: number): StrategyRuleOutcome {
  const effectiveMin = Math.max(MIN_CONVICTION_TO_TRADE, minConviction);
  const rule = `trade iff should_trade (noul > ${SHOULD_TRADE_NOUL_THRESHOLD}) AND direction in {up, down} AND conviction >= ${effectiveMin} AND response valid; up -> buy YES, down -> buy NO`;

  if (!decision.valid) {
    return {
      trade: false,
      side: null,
      reason: `Decision invalid: ${decision.parseErrors.join("; ") || decision.vetoReasons.join("; ") || "unknown"}`,
      rule,
    };
  }
  if (decision.parseErrors.length > 0) {
    return {
      trade: false,
      side: null,
      reason: `Parse errors present — refusing to trade on a partial response: ${decision.parseErrors.join("; ")}`,
      rule,
    };
  }
  if (decision.vetoReasons.length > 0 || !decision.shouldTrade) {
    return {
      trade: false,
      side: null,
      reason:
        decision.vetoReasons.length > 0
          ? `Vetoed: ${decision.vetoReasons.join("; ")}`
          : `Jev should_trade = ${decision.probabilities.shouldTradeNoul ?? "n/a"} (<= ${SHOULD_TRADE_NOUL_THRESHOLD}) — no trade signal`,
      rule,
    };
  }
  if (decision.direction === "pass") {
    return { trade: false, side: null, reason: "Jev direction = pass — no trade", rule };
  }
  if (decision.conviction < effectiveMin) {
    return {
      trade: false,
      side: null,
      reason: `Conviction ${decision.conviction} < required ${effectiveMin}`,
      rule,
    };
  }
  return {
    trade: true,
    side: decision.direction === "up" ? "yes" : "no",
    reason: `Jev ${decision.direction.toUpperCase()} conviction=${decision.conviction} should_trade=${decision.probabilities.shouldTradeNoul ?? "true"}`,
    rule,
  };
}
