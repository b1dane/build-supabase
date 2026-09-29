"""Hard risk vetoes — deterministic checks that run BEFORE any order.

These are enforced regardless of what Jev says. They are the final gate.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("kalshi_bot")

# ── Configurable thresholds ─────────────────────────────────────────────────

MAX_DATA_AGE_MS: float = 2_000.0  # data staleness veto
MAX_SPREAD_CENTS: int = 8  # spread veto (> 8 cents)
MAX_ALLOCATION_PCT: float = 0.15  # max 15% of balance per contract
MIN_CONTRACT_PRICE_CENTS: int = 5  # avoid lottery tickets
MAX_CONTRACT_PRICE_CENTS: int = 95  # avoid sure-thing pricing


@dataclass
class VetoResult:
    """Result of all veto checks. If any veto fires, no trade."""

    passed: bool = True
    reasons: list[str] = field(default_factory=list)

    def veto(self, reason: str) -> None:
        self.passed = False
        self.reasons.append(reason)

    @property
    def summary(self) -> str:
        if self.passed:
            return "VETOES: all clear"
        return f"VETOES: {'; '.join(self.reasons)}"


def check_vetoes(
    *,
    data_age_ms: float,
    yes_ask_cents: int | None,
    no_ask_cents: int | None,
    yes_bid_cents: int | None,
    no_bid_cents: int | None,
    current_exposure_cents: float,
    total_balance_cents: float,
) -> VetoResult:
    """Run all four hard veto checks in order.

    Returns a VetoResult — if not passed, the trade is blocked regardless
    of Jev or strategy output.
    """
    v = VetoResult()

    # 1. Data Staleness Veto
    if data_age_ms > MAX_DATA_AGE_MS:
        v.veto(
            f"Data stale {data_age_ms:.0f}ms > {MAX_DATA_AGE_MS:.0f}ms"
        )

    # 2. Spread Veto
    if yes_bid_cents is not None and yes_ask_cents is not None:
        spread = yes_ask_cents - yes_bid_cents
        if spread > MAX_SPREAD_CENTS:
            v.veto(
                f"Spread {spread}c > {MAX_SPREAD_CENTS}c veto"
            )

    # 3. Position Cap Veto
    max_position = total_balance_cents * MAX_ALLOCATION_PCT
    if current_exposure_cents >= max_position:
        v.veto(
            f"Exposure {current_exposure_cents:.0f}c >= cap {max_position:.0f}c"
        )

    # 4. Price Sanity Veto (avoid degenerate contracts)
    for label, ask in [("YES", yes_ask_cents), ("NO", no_ask_cents)]:
        if ask is not None:
            if ask < MIN_CONTRACT_PRICE_CENTS:
                v.veto(
                    f"{label} ask {ask}c < {MIN_CONTRACT_PRICE_CENTS}c min"
                )
            if ask > MAX_CONTRACT_PRICE_CENTS:
                v.veto(
                    f"{label} ask {ask}c > {MAX_CONTRACT_PRICE_CENTS}c max"
                )

    if v.passed:
        logger.info("All vetoes passed")
    else:
        logger.warning("Veto blocked: %s", "; ".join(v.reasons))

    return v
