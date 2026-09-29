"""Kalshi API client — public read-only endpoints.

Only uses unauthenticated GET requests against the trade-api v2.
Never places, modifies, or cancels orders.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from config import config

logger = logging.getLogger("kalshi_bot")
_HEADERS = {"User-Agent": "kalshi-bot/1.0", "Accept": "application/json"}


def _get(path: str, params: dict | None = None, timeout: int = 10) -> Any | None:
    """GET a Kalshi API path, return parsed JSON or None."""
    url = f"{config.KALSHI_BASE.rstrip('/')}/{path.lstrip('/')}"
    try:
        resp = httpx.get(url, params=params, headers=_HEADERS, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        logger.warning("Kalshi API %s failed: %s", url, exc)
        return None


def get_current_event(series: str | None = None) -> dict[str, Any] | None:
    """Return the latest open event for the series, or None.

    The /events list endpoint returns stubs with null fields and 0 markets.
    We fetch the stub to get the event_ticker, then fetch the full event
    detail from /events/{event_ticker} for complete data.
    """
    s = series or config.KALSHI_SERIES
    data = _get("events", {"series_ticker": s, "status": "open", "limit": 1})
    if not data:
        return None
    events = data.get("events") if isinstance(data, dict) else None
    if not events:
        return None

    # The stub has the ticker but null fields — fetch the full event detail
    stub = events[0]
    ticker = stub.get("event_ticker", "")
    if ticker:
        full = _get(f"events/{ticker}")
        if full and isinstance(full, dict) and full.get("event_ticker"):
            return full

    # Fall back to fetching markets directly
    if ticker:
        mkts = _get("markets", {"event_ticker": ticker, "limit": 5})
        if mkts and isinstance(mkts, dict):
            mlist = mkts.get("markets", [])
            if mlist:
                stub["markets"] = mlist
    return stub


def get_order_book(market_ticker: str) -> dict[str, Any] | None:
    """Return the order book for a market ticker."""
    return _get(f"markets/{market_ticker}/orderbook", timeout=8)


def get_recent_trades(
    market_ticker: str, limit: int = 20
) -> list[dict[str, Any]]:
    """Return recent trades for a market ticker.

    The public v2 API may not expose a /trades endpoint (404).
    Returns empty list silently in that case — the flow veto
    in book_signal simply won't fire.
    """
    data = _get(
        f"markets/{market_ticker}/trades", {"limit": limit}, timeout=8
    )
    if isinstance(data, dict):
        return data.get("trades", [])
    return []


def get_market(market_ticker: str) -> dict[str, Any] | None:
    """Fetch a single market by ticker."""
    return _get(f"markets/{market_ticker}", timeout=8)


def compute_target_price(market: dict[str, Any]) -> float | None:
    """Extract BTC target/floor price from market metadata."""
    # Prefer explicit floor_strike / cap_strike
    strike = market.get("floor_strike") or market.get("cap_strike")
    if strike is not None:
        try:
            return float(strike)
        except (TypeError, ValueError):
            pass
    # Fall back to parsing yes_sub_title like "BTC ≥ $104,500"
    subtitle = market.get("yes_sub_title", "")
    if subtitle and "$" in subtitle:
        try:
            cleaned = subtitle.split("$")[-1].replace(",", "").split()[0]
            return float(cleaned)
        except (ValueError, IndexError):
            pass
    return None
