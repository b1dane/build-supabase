"""Strategy router — hardcoded Python logic that consumes Jev's classifications.

Three strategies, each with deterministic entry conditions:

  1. Directional Impulse Arbitrage (Lead-Lag)
     - Jev says STRONG_UP/DOWN with confidence >= 0.65
     - Toxicity <= 4 (safe entry)
     - Lead price moved > +0.35% while Kalshi Prob lagged

  2. Passive Market Making / Spread Capture
     - Jev says NEUTRAL
     - Fill probability >= 0.40
     - Toxicity <= 3 (very safe)

  3. Mean Reversion / Fade Over-reaction
     - Lead is flat but Kalshi order book shows retail spike
     - Toxicity >= 7 on the spike side

Jev classifies; this module decides what to do about it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any

logger = logging.getLogger("kalshi_bot")

# ── Tunables ────────────────────────────────────────────────────────────────

MIN_CONFIDENCE_IMPULSE: float = 0.65
MAX_TOXICITY_IMPULSE: int = 4
MIN_LEAD_MOVE_BPS: float = 35.0  # 0.35%

MIN_FILL_PROB_MM: float = 0.40
MAX_TOXICITY_MM: int = 3

MIN_TOXICITY_FADE: int = 7
MAX_DRIFT_FADE_BPS: float = 10.0  # flat = drift below 10bps


class ActionType(Enum):
    NO_ACTION = auto()
    BUY_YES_AGGRESSIVE = auto()
    BUY_NO_AGGRESSIVE = auto()
    POST_YES_LIMIT = auto()
    POST_NO_LIMIT = auto()
    FADE_YES = auto()
    FADE_NO = auto()


@dataclass
class StrategySignal:
    """Output from the strategy router — what to do and why."""

    action: ActionType = ActionType.NO_ACTION
    strategy: str = "none"  # "impulse" | "market_making" | "fade"
    conviction: int = 0  # 0-3
    price_cents: int = 0  # target limit price in cents
    contracts: int = 0
    reasons: list[str] = field(default_factory=list)

    @property
    def should_act(self) -> bool:
        return self.action != ActionType.NO_ACTION

    def summary(self) -> str:
        if not self.should_act:
            return f"STRAT no action ({'; '.join(self.reasons) or 'no signal'})"
        return (
            f"STRAT {self.action.name} ({self.strategy}) "
            f"conv={self.conviction} @ {self.price_cents}c x{self.contracts}"
        )


def compute_contracts(
    conviction: int, balance_cents: float, entry_price_cents: int
) -> int:
    """Risk-based position sizing by conviction level."""
    fracs = {0: 0.0, 1: 0.05, 2: 0.10, 3: 0.15}
    frac = fracs.get(conviction, 0.05)
    budget = balance_cents * frac
    if entry_price_cents <= 0:
        return 0
    return int(budget / entry_price_cents)


# ── Strategy 1: Directional Impulse Arbitrage ──────────────────────────────


def _strategy_impulse(
    direction: str,
    confidence: float,
    toxicity: int,
    lead_drift_bps: float,
    kalshi_implied_prob: float | None,
    yes_ask_cents: int,
    no_ask_cents: int,
    balance_cents: float,
) -> StrategySignal | None:
    """Check lead-lag arbitrage conditions."""
    if confidence < MIN_CONFIDENCE_IMPULSE:
        return None
    if toxicity > MAX_TOXICITY_IMPULSE:
        return None
    if abs(lead_drift_bps) < MIN_LEAD_MOVE_BPS:
        return None

    # Direction check
    if direction == "STRONG_UP" and lead_drift_bps > 0:
        sig = StrategySignal(
            action=ActionType.BUY_YES_AGGRESSIVE,
            strategy="impulse",
            conviction=3 if toxicity <= 2 else 2,
            price_cents=yes_ask_cents,
        )
        sig.reasons.append(f"lead {lead_drift_bps:.0f}bps UP")
        if kalshi_implied_prob is not None:
            sig.reasons.append(f"Kalshi prob {kalshi_implied_prob:.2f}")
        return sig

    if direction == "STRONG_DOWN" and lead_drift_bps < 0:
        sig = StrategySignal(
            action=ActionType.BUY_NO_AGGRESSIVE,
            strategy="impulse",
            conviction=3 if toxicity <= 2 else 2,
            price_cents=no_ask_cents,
        )
        sig.reasons.append(f"lead {lead_drift_bps:.0f}bps DOWN")
        if kalshi_implied_prob is not None:
            sig.reasons.append(f"Kalshi prob {kalshi_implied_prob:.2f}")
        return sig

    return None


# ── Strategy 2: Passive Market Making ──────────────────────────────────────


def _strategy_market_making(
    direction: str,
    fill_prob: float,
    toxicity: int,
    yes_bid_cents: int,
    yes_ask_cents: int,
    no_bid_cents: int,
    no_ask_cents: int,
    balance_cents: float,
) -> StrategySignal | None:
    """Check if we can safely capture the spread."""
    if direction != "NEUTRAL":
        return None
    if fill_prob < MIN_FILL_PROB_MM:
        return None
    if toxicity > MAX_TOXICITY_MM:
        return None

    spread = yes_ask_cents - yes_bid_cents
    if spread < 2:  # spread too tight to capture
        return None

    # Post limit orders inside the spread
    yes_price = yes_bid_cents + 1  # one tick inside
    no_price = no_bid_cents + 1
    sig = StrategySignal(
        strategy="market_making",
        conviction=2 if fill_prob >= 0.60 else 1,
        reasons=[f"fill_prob={fill_prob:.2f}", f"spread={spread}c"],
    )

    # Pick the side with better relative value
    if yes_price < no_price:
        sig.action = ActionType.POST_YES_LIMIT
        sig.price_cents = yes_price
    else:
        sig.action = ActionType.POST_NO_LIMIT
        sig.price_cents = no_price

    return sig


# ── Strategy 3: Mean Reversion / Fade ──────────────────────────────────────


def _strategy_fade(
    direction: str,
    toxicity: int,
    lead_drift_bps: float,
    imbalance: float,
    yes_ask_cents: int,
    no_ask_cents: int,
    balance_cents: float,
) -> StrategySignal | None:
    """Check for over-reaction to fade."""
    if toxicity < MIN_TOXICITY_FADE:
        return None
    if abs(lead_drift_bps) > MAX_DRIFT_FADE_BPS:
        return None  # lead is moving, not flat — not a fade setup

    # High toxicity means the spike side is dangerous — fade it
    if abs(imbalance) < 0.3:
        return None  # no clear order book spike

    sig = StrategySignal(
        strategy="fade",
        conviction=2,
        reasons=[f"toxicity={toxicity}", f"imbalance={imbalance:+.2f}"],
    )

    # Imbalance positive = buy pressure on YES = fade with NO
    if imbalance > 0.3:
        sig.action = ActionType.FADE_NO
        sig.price_cents = no_ask_cents
    elif imbalance < -0.3:
        sig.action = ActionType.FADE_YES
        sig.price_cents = yes_ask_cents
    else:
        return None

    return sig


# ── Public Router ──────────────────────────────────────────────────────────


def route(
    *,
    # Jev output
    jev_direction: str,
    jev_confidence: float,
    jev_fill_prob: float,
    jev_toxicity: int,
    # Lead market data
    lead_drift_bps: float,
    lead_imbalance: float,
    # Kalshi prices (cents)
    yes_bid_cents: int,
    yes_ask_cents: int,
    no_bid_cents: int,
    no_ask_cents: int,
    kalshi_implied_prob: float | None,
    # Risk
    balance_cents: float,
) -> StrategySignal:
    """Route Jev's classification + market data to the appropriate strategy."""
    sig = StrategySignal()

    # Try strategies in priority order
    for check in [
        lambda: _strategy_impulse(
            jev_direction, jev_confidence, jev_toxicity,
            lead_drift_bps, kalshi_implied_prob,
            yes_ask_cents, no_ask_cents, balance_cents,
        ),
        lambda: _strategy_market_making(
            jev_direction, jev_fill_prob, jev_toxicity,
            yes_bid_cents, yes_ask_cents,
            no_bid_cents, no_ask_cents, balance_cents,
        ),
        lambda: _strategy_fade(
            jev_direction, jev_toxicity,
            lead_drift_bps, lead_imbalance,
            yes_ask_cents, no_ask_cents, balance_cents,
        ),
    ]:
        try:
            result = check()
            if result is not None and result.should_act:
                result.contracts = compute_contracts(
                    result.conviction, balance_cents, result.price_cents
                )
                logger.info(result.summary())
                return result
        except Exception as exc:
            logger.warning("Strategy check error: %s", exc)
            continue

    # No strategy triggered
    sig.reasons.append("no strategy conditions met")
    logger.info("Strat: no action")
    return sig
