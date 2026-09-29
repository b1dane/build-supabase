"""Kalshi reciprocal order book parser and quadratic fee calculator.

Kalshi only returns BIDS in the order book. Asks are derived:
  YES Ask = 100 - MAX(NO Bid)
  NO Ask  = 100 - MAX(YES Bid)

Fee formula (quadratic in price):
  Taker fee = ceil(multiplier * 0.07 * contracts * P * (1-P))
  Maker fee = ceil(multiplier * 0.0175 * contracts * P * (1-P))
  where P is in dollars (e.g. 42¢ = $0.42)

Fees peak at P=0.50 (50¢), costing up to 1.75¢/contract taker.
"""
from __future__ import annotations

import math
from typing import Any


def parse_book_and_fees(
    yes_bids: list[tuple[int, int]],
    no_bids: list[tuple[int, int]],
    contracts: int = 1,
    is_taker: bool = True,
    multiplier: float = 1.0,
) -> dict[str, Any]:
    """Parse Kalshi order book and compute fees.

    Args:
        yes_bids: List of [price_cents, quantity] for YES bids.
        no_bids: List of [price_cents, quantity] for NO bids.
        contracts: Order size for fee evaluation.
        is_taker: True for crossing spread, False for resting limit.
        multiplier: Series fee multiplier (1.0 for most crypto/general).

    Returns:
        Dict with quotes (bid, ask, spread, midpoint) and fees.
    """
    # 1. Best bids (highest price in cents)
    best_yes_bid_cents = max((b[0] for b in yes_bids), default=0)
    best_no_bid_cents = max((b[0] for b in no_bids), default=0)

    # 2. Derive implied YES asks via reciprocal pricing
    best_yes_ask_cents = (100 - best_no_bid_cents) if best_no_bid_cents > 0 else 100

    # 3. Spreads
    spread_cents = best_yes_ask_cents - best_yes_bid_cents
    midpoint_cents = (best_yes_bid_cents + best_yes_ask_cents) / 2.0

    # 4. Fee calculation helper
    def _fee(price_cents: int, qty: int, taker: bool) -> float:
        if price_cents <= 0 or price_cents >= 100 or qty <= 0:
            return 0.0
        p = price_cents / 100.0
        coeff = 0.07 if taker else 0.0175
        raw = multiplier * coeff * qty * p * (1.0 - p)
        return math.ceil(raw * 100.0) / 100.0

    # 5. Fees
    yes_bid_fee = _fee(best_yes_bid_cents, contracts, is_taker)
    yes_ask_fee = _fee(best_yes_ask_cents, contracts, is_taker)

    # 6. Round-trip taker cost
    roundtrip = _fee(best_yes_ask_cents, contracts, True) + _fee(
        best_yes_bid_cents, contracts, True
    )
    min_profitable_move_cents = spread_cents + math.ceil(
        roundtrip * 100 / contracts
    ) if contracts > 0 else spread_cents

    return {
        "quotes": {
            "yes_bid_cents": best_yes_bid_cents,
            "yes_ask_cents": best_yes_ask_cents,
            "spread_cents": spread_cents,
            "midpoint_cents": midpoint_cents,
            "implied_yes_prob": round(midpoint_cents / 100.0, 4),
        },
        "fees": {
            "buy_yes_ask_fee_usd": yes_ask_fee,
            "sell_yes_bid_fee_usd": yes_bid_fee,
            "roundtrip_taker_fee_usd": roundtrip,
            "min_profitable_move_cents": min_profitable_move_cents,
        },
    }
