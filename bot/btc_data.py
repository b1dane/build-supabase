"""Thin wrapper around BtcFeed providing get_btc_snapshot().

The runner imports `from btc_data import get_btc_snapshot` and expects a
dict with keys like "btc_spot", "btc_klines", and "btc_source".
"""
from __future__ import annotations

from btc_feed import BtcFeed

_feed = BtcFeed()


def get_btc_snapshot(limit: int = 60) -> dict:
    """Return BTC klines + latest spot price + source name.

    Keys:
        btc_spot    — latest close price (float) or None
        btc_klines  — raw klines list or None
        btc_source  — human-readable source name
    """
    klines = _feed.get_klines(limit=limit)
    result = {
        "btc_spot": None,
        "btc_klines": klines,
        "btc_source": _feed.source,
    }
    if klines and len(klines) >= 2:
        try:
            result["btc_spot"] = float(klines[-1][4])
        except (TypeError, ValueError, IndexError):
            pass
    return result
