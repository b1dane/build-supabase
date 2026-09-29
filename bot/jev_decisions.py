"""Jev decision engine — batched three-question call to TypeSafe AI (PAPER ONLY).

Drop-in replacement for the original module. Same public interface:
    decide_trade(event_data, price_context) -> DecisionResult

Asks all three typed questions in ONE call to POST /v1/systemone:
  - direction    (choice): up / down / pass
  - conviction   (score):  levels 0..3
  - should_trade (noul):   probability the trade statement is true

IMPORTANT (from TypeSafe docs): questions are answered "in parallel and in
isolation against the same state". `should_trade` never sees the `direction`
answer, so the two can contradict each other. This module reconciles them in
code and FAILS CLOSED: any parse error, a "pass" direction, or a conviction
of 0 ("no signal") forces should_trade = False.

This module only returns advice. It never places, modifies, or cancels orders.
Every paper order must still pass the simulator's server-side limits
(first bet <= $5, +30% progression gate, +75% hard stop, never negative).

Fixes vs. the original (each reproduced by running the original code):
  A. direction="pass" + noul>0.5 returned should_trade=True.
  B. Invalid/missing direction or conviction still returned should_trade=True.
  C. conviction=0 (your own rubric: "No signal") could still trade.
  D. mid_price = (yes+no)/2 is always ~0.50; now uses YES bid/ask.
  E. Order-book "best" used index [0]; now uses max price (sort-order safe),
     and a NO bid is labeled as implying YES ask = 1 - p.
  F. Removed undocumented request fields ("options" on choice, "levels" on
     score). Score levels belong in "criteria" per the API reference.
  G. Rules text corrected for KXBTC15M: YES if the 60s BRTI average at close
     is AT LEAST the target (ties resolve YES), not strictly "above".
  H. Removed the JSON "response format" block from state. The typed API
     does not read it and never returns "reasoning".
  I. bool checked before int/float (bool is a subclass of int).
  J. Conviction uses floor(score + 0.5), not banker's round() (round(2.5) == 2).
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from typing import Any

import httpx

from config import config

logger = logging.getLogger("kalshi_bot")

# Documented endpoint: https://docs.typesafe.ai/introduction/quickstart
DEFAULT_JEV_API_URL = "https://api.typesafe.ai/v1/systemone"

# Your original threshold, kept unchanged.
SHOULD_TRADE_NOUL_THRESHOLD = 0.5
# Your own rubric defines level 0 as "No signal or conflicting indicators".
# Trading on "no signal" contradicts the rubric, so level 0 never trades.
MIN_CONVICTION_TO_TRADE = 1

VALID_DIRECTIONS = ("up", "down", "pass")


@dataclass
class DecisionResult:
    """Structured decision output from a single batched Jev call."""

    direction: str  # "up" | "down" | "pass"
    conviction: int  # 0-3
    should_trade: bool  # True only if every check passed
    raw_response: str = ""
    parse_errors: list[str] = field(default_factory=list)
    reasoning: str = ""
    direction_confidence: float | None = None
    conviction_score_raw: float | None = None
    should_trade_probability: float | None = None
    veto_reasons: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return (
            not self.parse_errors
            and self.direction in VALID_DIRECTIONS
            and 0 <= self.conviction <= 3
        )

    @property
    def kalshi_side(self) -> str | None:
        """Map direction to the Kalshi contract side. None if not trading."""
        if not self.should_trade:
            return None
        return "yes" if self.direction == "up" else "no"

    def summary(self) -> str:
        if not self.should_trade:
            why = f" — {'; '.join(self.veto_reasons)}" if self.veto_reasons else ""
            return f"NO TRADE (direction={self.direction}, conviction={self.conviction}){why}"
        return f"{self.direction.upper()} → PAPER {self.kalshi_side.upper()} (conviction={self.conviction})"


# ── State builder ───────────────────────────────────────────────────────────


def _num(v: Any) -> float | None:
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _best_level(levels: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Highest-priced bid level, regardless of how the list is sorted."""
    priced = [lv for lv in levels or [] if _num(lv.get("price")) is not None]
    return max(priced, key=lambda lv: _num(lv["price"])) if priced else None


def _build_state(event_data: dict[str, Any], price_context: dict[str, Any]) -> dict[str, Any]:
    """Build structured state (the API accepts objects, not just strings)."""
    markets = event_data.get("markets", []) or []

    yes_bid = _num(price_context.get("yes_bid"))
    yes_ask = _num(price_context.get("yes_ask", price_context.get("yes_price")))
    no_ask = _num(price_context.get("no_ask", price_context.get("no_price")))

    best_yes_bid = _best_level(price_context.get("order_book_yes", []))
    best_no_bid = _best_level(price_context.get("order_book_no", []))
    if yes_bid is None and best_yes_bid:
        yes_bid = _num(best_yes_bid["price"])
    implied_yes_ask_from_no_bid = (
        round(1 - _num(best_no_bid["price"]), 4) if best_no_bid else None
    )

    mid = round((yes_bid + yes_ask) / 2, 4) if yes_bid is not None and yes_ask is not None else None

    recent = price_context.get("recent_trades", []) or []

    return {
        "product": "Kalshi KXBTC15M — Bitcoin price up/down, 15-minute window",
        "settlement_rule": (
            "Resolves YES if the simple average of the 60 seconds of CF Benchmarks' BRTI "
            "before the window close is AT LEAST the simple average of the 60 seconds of "
            "BRTI before the window open (the 'target price'). Ties resolve YES. "
            "Otherwise resolves NO. Winning contracts pay $1.00; losing pay $0.00."
        ),
        "event_ticker": event_data.get("event_ticker", "unknown"),
        "target_price_note": event_data.get("yes_sub_title") or price_context.get("target_price_note"),
        "window_open": event_data.get("open_time"),
        "window_close": event_data.get("close_time"),
        "quotes": {
            "yes_bid": yes_bid,
            "yes_ask": yes_ask,
            "no_ask": no_ask,
            "yes_mid": mid,
            "yes_ask_implied_prob_pct": round(yes_ask * 100, 1) if yes_ask is not None else None,
            "best_yes_bid_level": best_yes_bid,
            "best_no_bid_level": best_no_bid,
            "implied_yes_ask_from_best_no_bid": implied_yes_ask_from_no_bid,
        },
        "recent_trades": recent[:5],
        "markets": [
            {
                "ticker": m.get("ticker"),
                "title": m.get("title"),
                "yes_ask": m.get("yes_ask_dollars", m.get("yes_price")),
                "no_ask": m.get("no_ask_dollars", m.get("no_price")),
            }
            for m in markets[:5]
        ],
    }


# ── Jev API call ────────────────────────────────────────────────────────────

QUESTIONS: dict[str, Any] = {
    "direction": {
        "type": "choice",
        "instructions": "Which outcome of this Kalshi BTC 15-minute up/down window is more likely, or is there too little signal to act?",
        "criteria": {
            "up": "The 60s BRTI average at close will be at least the target price (contract resolves YES)",
            "down": "The 60s BRTI average at close will be below the target price (contract resolves NO)",
            "pass": "Not enough signal to prefer either side at the current prices",
        },
    },
    "conviction": {
        "type": "score",
        "instructions": "How strong is the evidence in the state for a directional view?",
        "criteria": [
            "No signal or conflicting indicators",
            "Weak directional bias, low confidence",
            "Moderate confidence in predicted direction",
            "Strong conviction in predicted direction",
        ],
    },
    "should_trade": {
        "type": "noul",
        # Noul instructions are statements to be judged true/false.
        "instructions": "Buying a contract at the current ask has positive expected value given the evidence in the state.",
    },
}


def _call_jev(state: dict[str, Any]) -> dict[str, Any] | None:
    """One batched call. Returns the 'answers' dict or None on any failure."""
    if not config.jev_configured:
        logger.warning("Jev API key not configured — cannot call Jev")
        return None

    url = getattr(config, "JEV_API_URL", None) or DEFAULT_JEV_API_URL
    headers = {
        "Authorization": f"Bearer {config.JEV_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {"model": "jev-latest", "state": state, "questions": QUESTIONS}

    try:
        resp = httpx.post(url, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        answers = data.get("answers") if isinstance(data, dict) else None
        if not isinstance(answers, dict):
            logger.warning("Jev response has no 'answers' object (keys=%s)", list(data)[:10] if isinstance(data, dict) else type(data).__name__)
            return None
        return answers
    except httpx.HTTPStatusError as exc:
        # Never log headers — they contain the bearer token.
        logger.warning("Jev API HTTP %s: %.200s", exc.response.status_code, exc.response.text)
    except httpx.TimeoutException:
        logger.warning("Jev API timeout (30s)")
    except httpx.RequestError as exc:
        logger.warning("Jev API request error: %s", type(exc).__name__)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Jev API returned non-JSON: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected Jev API error: %s", exc)
    return None


# ── Parser (fail-closed) ────────────────────────────────────────────────────


def _parse_jev_response(raw: dict[str, Any] | None) -> DecisionResult:
    result = DecisionResult(direction="pass", conviction=0, should_trade=False)

    if raw is None:
        result.parse_errors.append("No response from Jev API")
        result.veto_reasons.append("no response")
        return result

    result.raw_response = json.dumps(raw)

    # direction (choice)
    d = raw.get("direction")
    if isinstance(d, dict):
        choice = d.get("choice")
        if isinstance(choice, str) and choice.strip().lower() in VALID_DIRECTIONS:
            result.direction = choice.strip().lower()
        else:
            result.parse_errors.append(f"Invalid or missing direction choice: {choice!r}")
        conf = _num(d.get("confidence"))
        result.direction_confidence = conf
    else:
        result.parse_errors.append(f"Unexpected direction format: {type(d).__name__}")

    # conviction (score, probability-weighted float 0..3)
    c = raw.get("conviction")
    if isinstance(c, dict):
        score = c.get("score")
        if isinstance(score, bool) or _num(score) is None:
            result.parse_errors.append(f"Invalid or missing conviction score: {score!r}")
        else:
            s = _num(score)
            result.conviction_score_raw = s
            result.conviction = max(0, min(3, math.floor(s + 0.5)))
    else:
        result.parse_errors.append(f"Unexpected conviction format: {type(c).__name__}")

    # should_trade (noul, probability 0..1) — bool checked FIRST
    t = raw.get("should_trade")
    noul_says_trade = False
    if isinstance(t, dict):
        noul = t.get("noul")
        if isinstance(noul, bool):
            result.should_trade_probability = 1.0 if noul else 0.0
            noul_says_trade = noul
        elif _num(noul) is not None and 0.0 <= _num(noul) <= 1.0:
            result.should_trade_probability = _num(noul)
            noul_says_trade = _num(noul) > SHOULD_TRADE_NOUL_THRESHOLD
        else:
            result.parse_errors.append(f"Invalid or missing noul value: {noul!r}")
    else:
        result.parse_errors.append(f"Unexpected should_trade format: {type(t).__name__}")

    # ── Reconcile the three independent answers (fail closed) ──
    if result.parse_errors:
        result.veto_reasons.append(f"{len(result.parse_errors)} parse error(s)")
    if result.direction == "pass":
        result.veto_reasons.append("direction is pass")
    if result.conviction < MIN_CONVICTION_TO_TRADE:
        result.veto_reasons.append(f"conviction {result.conviction} < {MIN_CONVICTION_TO_TRADE} (no signal)")
    if not noul_says_trade:
        result.veto_reasons.append(
            f"should_trade probability {result.should_trade_probability} <= {SHOULD_TRADE_NOUL_THRESHOLD}"
        )

    result.should_trade = noul_says_trade and not result.veto_reasons

    parts = []
    for key in ("direction", "conviction"):
        entry = raw.get(key)
        if isinstance(entry, dict) and "probabilities" in entry:
            parts.append(f"{key}={entry['probabilities']}")
    if result.should_trade_probability is not None:
        parts.append(f"should_trade={result.should_trade_probability:.2f}")
    result.reasoning = "; ".join(parts)

    return result


# ── Public interface ────────────────────────────────────────────────────────


def decide_trade(event_data: dict[str, Any], price_context: dict[str, Any]) -> DecisionResult:
    """Single batched Jev call. Returns ADVICE only — never places an order."""
    state = _build_state(event_data, price_context)
    decision = _parse_jev_response(_call_jev(state))
    logger.info("Jev decision: %s%s", decision.summary(), f" — {decision.reasoning[:160]}" if decision.reasoning else "")
    return decision
