"""Helper functions shared between the old polling runner and the new async runner."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _to_dollars(value: Any) -> float | None:
    """Convert a Kalshi price to dollars. Handles '0.56' strings and cents ints."""
    if value is None or value == "":
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v > 1.0:  # cents (e.g. 56) -> dollars
        v /= 100.0
    return v if 0.0 < v < 1.0 else None


def _to_cents(value: Any) -> int | None:
    """Convert a Kalshi price to cents int. Handles '0.56' strings and '56' ints."""
    if value is None or value == "":
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v < 1.0:  # dollars -> cents
        return int(round(v * 100))
    if v > 1.0 and v < 200:  # already cents but stored as float
        return int(round(v))
    return int(round(v))


def _first_price(market: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        p = _to_dollars(market.get(key))
        if p is not None:
            return p
    return None


def _first_price_cents(market: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        p = _to_cents(market.get(key))
        if p is not None:
            return p
    return None


def get_ask_prices_cents(
    market: dict[str, Any],
) -> tuple[int | None, int | None, int | None, int | None] | None:
    """Return (yes_ask_c, no_ask_c, yes_bid_c, no_bid_c) in cents, or None."""
    yes_ask = _first_price_cents(market, "yes_ask_dollars", "yes_ask")
    no_ask = _first_price_cents(market, "no_ask_dollars", "no_ask")
    yes_bid = _first_price_cents(market, "yes_bid_dollars", "yes_bid")
    no_bid = _first_price_cents(market, "no_bid_dollars", "no_bid")

    if yes_ask is None and no_bid is not None:
        yes_ask = 100 - no_bid
    if no_ask is None and yes_bid is not None:
        no_ask = 100 - yes_bid

    if yes_ask is None or no_ask is None:
        return None
    return yes_ask, no_ask, yes_bid, no_bid


def normalize_book(
    order_book: dict[str, Any] | None,
) -> tuple[list[dict], list[dict]]:
    """Turn Kalshi's orderbook into lists of {"price", "count"} dicts."""
    if not order_book:
        return [], []
    book = (
        order_book.get("orderbook")
        or order_book.get("orderbook_fp")
        or order_book
    )

    def _side(levels: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for lvl in levels or []:
            try:
                if isinstance(lvl, dict):
                    price, count = lvl.get("price"), lvl.get("count", 0)
                else:
                    price, count = lvl[0], lvl[1]
                p = _to_dollars(price)
                if p is not None:
                    out.append({"price": p, "count": float(count)})
            except (IndexError, TypeError, ValueError):
                continue
        out.sort(key=lambda d: d["price"], reverse=True)
        return out

    return _side(book.get("yes") or book.get("yes_dollars")), _side(
        book.get("no") or book.get("no_dollars")
    )


def _window_start_ms(
    event: dict[str, Any], market: dict[str, Any] | None = None
) -> int | None:
    """Unix ms of the event window open time."""
    raw = event.get("open_time")
    if not raw and market:
        raw = market.get("open_time")
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def _minutes_to_close(*sources: dict[str, Any]) -> float | None:
    """Minutes until the market/event closes, from the first close_time found."""
    for src in sources:
        raw = src.get("close_time") or src.get("expected_expiration_time")
        if not raw:
            continue
        try:
            close = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            if close.tzinfo is None:
                close = close.replace(tzinfo=timezone.utc)
            return round(
                (close - datetime.now(timezone.utc)).total_seconds() / 60, 1
            )
        except ValueError:
            continue
    return None
