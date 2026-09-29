"""Feature engine — compresses live market data into a compact state dict (<400 tokens).

No raw order book arrays. Only pre-computed summary metrics:
  - 5m drift in bps
  - Order book imbalance ratio (-1..1)
  - Spread width in bps
  - Volume pressure at top levels
  - Source health

Designed to keep Jev API latency sub-100ms.
"""
from __future__ import annotations

import logging
from typing import Any

from data_ingestion import MarketSnapshot, SourceState

logger = logging.getLogger("kalshi_bot")

# Kalshi target placeholder — hardcoded per contract
KALSHI_TARGET_TICKER = "KXBTC15M"


def build_state(
    snapshot: MarketSnapshot,
    source_state: SourceState,
    kalshi_yes_bid: int | None,
    kalshi_yes_ask: int | None,
    kalshi_no_bid: int | None,
    kalshi_no_ask: int | None,
) -> dict[str, Any]:
    """Build a compact state dict (<400 tokens) from live market data.

    Args:
        snapshot: Current MarketSnapshot from DataIngestionService.
        source_state: Current source state enum.
        kalshi_*: Kalshi order book prices in cents (ints).

    Returns:
        Dict with pre-computed metrics only. No raw depth arrays.
    """
    lead_source = "binance_realtime" if source_state in (
        SourceState.CONNECTED_BINANCE, SourceState.RECOVERING
    ) else "coinbase_15m_fallback"

    # Kalshi implied probability from midpoint of yes bid/ask
    kalshi_implied = None
    if kalshi_yes_bid is not None and kalshi_yes_ask is not None:
        kalshi_implied = round((kalshi_yes_bid + kalshi_yes_ask) / 2 / 100, 4)

    # Spread width in bps (relative to mid price)
    spread_bps = 0.0
    if snapshot.ask_depth and snapshot.bid_depth and snapshot.btc_price > 0:
        best_ask = snapshot.ask_depth[0][0]
        best_bid = snapshot.bid_depth[0][0]
        spread_bps = round((best_ask - best_bid) / snapshot.btc_price * 10_000, 2)

    # Volume pressure: ratio of bid volume to total at top 5 levels
    bid_vol = sum(q for _, q in snapshot.bid_depth[:5])
    ask_vol = sum(q for _, q in snapshot.ask_depth[:5])
    total_vol = bid_vol + ask_vol
    vol_pressure = round(bid_vol / total_vol, 3) if total_vol > 0 else 0.5

    state = {
        "src": lead_source,
        "sym": "BTCUSD",
        "px": round(snapshot.btc_price, 2),
        "dr5": round(snapshot.drift_5m_bps, 1),
        "imb": round(snapshot.imbalance, 4),
        "spr": spread_bps,
        "vpr": vol_pressure,
        "ktk": KALSHI_TARGET_TICKER,
        "kyb": kalshi_yes_bid,
        "kya": kalshi_yes_ask,
        "knb": kalshi_no_bid,
        "kna": kalshi_no_ask,
        "kip": kalshi_implied,
        "age": round(time_ms() - snapshot.timestamp_ms, 0),
    }

    # Compact: remove None fields
    return {k: v for k, v in state.items() if v is not None}


def time_ms() -> float:
    import time
    return time.time() * 1000
