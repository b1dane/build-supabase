"""Real-time BTC candles from Binance, with automatic fallbacks.

Binance's main API (api.binance.com) is blocked in some countries (HTTP 451,
notably the US). We try, in order, and remember whichever host works:
  1. https://api.binance.com        (BTCUSDT)
  2. https://data-api.binance.vision (BTCUSDT, market-data only)
  3. https://api.binance.us          (BTCUSD)
  4. Coinbase Exchange               (BTC-USD, converted to the same shape)

Every source returns rows shaped like Binance klines, OLDEST FIRST:
  [open_time_ms, open, high, low, close, volume, ...]
The last row is the still-forming candle, so its close is the live price.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("kalshi_bot")

_HEADERS = {"User-Agent": "kalshi-bot/1.0"}

_BINANCE_HOSTS = [
    ("https://api.binance.com", "BTCUSDT", "binance"),
    ("https://data-api.binance.vision", "BTCUSDT", "binance-vision"),
    ("https://api.binance.us", "BTCUSD", "binance-us"),
]
_COINBASE_URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles"


class BtcFeed:
    """Fetches 1-minute candles; caches the first working source."""

    def __init__(self) -> None:
        self._preferred = 0
        self.source: str = "none"

    def get_klines(self, limit: int = 60) -> list[list[Any]] | None:
        """Return up to `limit` 1m candles (oldest first) or None on total failure."""
        order = list(range(len(_BINANCE_HOSTS)))
        order = order[self._preferred:] + order[: self._preferred]

        for idx in order:
            host, symbol, name = _BINANCE_HOSTS[idx]
            try:
                resp = httpx.get(
                    f"{host}/api/v3/klines",
                    params={"symbol": symbol, "interval": "1m", "limit": limit},
                    headers=_HEADERS,
                    timeout=8,
                )
                if resp.status_code in (451, 403, 418, 429):
                    logger.debug("%s unavailable (HTTP %d)", name, resp.status_code)
                    continue
                resp.raise_for_status()
                rows = resp.json()
                if isinstance(rows, list) and len(rows) >= 15:
                    if self.source != name:
                        logger.info("BTC feed source: %s", name)
                    self._preferred, self.source = idx, name
                    return rows
            except (httpx.HTTPError, ValueError) as exc:
                logger.debug("%s failed: %s", name, type(exc).__name__)

        return self._coinbase_klines(limit)

    def _coinbase_klines(self, limit: int) -> list[list[Any]] | None:
        try:
            resp = httpx.get(
                _COINBASE_URL, params={"granularity": 60}, headers=_HEADERS, timeout=8
            )
            resp.raise_for_status()
            rows = resp.json()  # newest first: [time_s, low, high, open, close, volume]
            if not isinstance(rows, list) or len(rows) < 15:
                return None
            out = [
                [int(r[0]) * 1000, r[3], r[2], r[1], r[4], r[5]]
                for r in reversed(rows[:limit])
            ]
            if self.source != "coinbase":
                logger.warning("Binance unreachable — using Coinbase for BTC prices")
            self.source = "coinbase"
            return out
        except (httpx.HTTPError, ValueError, IndexError, TypeError) as exc:
            logger.warning("All BTC price sources failed (%s)", type(exc).__name__)
        return None
