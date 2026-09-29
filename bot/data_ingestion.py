"""Async data ingestion with Binance WebSocket primary + Coinbase fallback.

State machine:
  CONNECTED_BINANCE — receiving live Binance WS data, heartbeat fresh
  FALLBACK_COINBASE — Binance stale/dropped, polling Coinbase REST
  RECOVERING        — Binance reconnected, verifying 5s clean data
  STOPPED           — shutdown

Heartbeat: Binance WS sends a ping frame every 3 minutes automatically
but depth streams include an 'E' event-time field we track. If last
event time > 1,500ms old, trigger fallback. Recover after 5s clean data.
"""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Callable

import websockets

logger = logging.getLogger("kalshi_bot")

# ── Constants ──────────────────────────────────────────────────────────────

BINANCE_DEPTH_URL = "wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms"
BINANCE_TRADE_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade"
BINANCE_COMBINED = (
    "wss://stream.binance.com:9443/stream?streams=btcusdt@depth20@100ms/btcusdt@trade"
)

COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com"

STALE_MS = 1_500  # trigger fallback
RECOVERY_CLEAN_S = 5  # seconds of clean data before failing back
MAX_RECONNECT_DELAY = 30  # max backoff between reconnects
MOVEMENT_THRESHOLD_BPS = 5.0  # min drift to trigger Jev gate

_HEADERS = {"User-Agent": "kalshi-bot/2.0"}


# ── Types ───────────────────────────────────────────────────────────────────


class SourceState(Enum):
    CONNECTED_BINANCE = auto()
    FALLBACK_COINBASE = auto()
    RECOVERING = auto()
    STOPPED = auto()


@dataclass
class MarketSnapshot:
    """The latest consolidated market data from whichever source is active."""

    source: str = "none"  # "binance" | "coinbase"
    timestamp_ms: float = 0.0
    btc_price: float = 0.0
    bid_depth: list[tuple[float, float]] = field(default_factory=list)
    ask_depth: list[tuple[float, float]] = field(default_factory=list)
    imbalance: float = 0.0  # computed from top levels
    drift_5m_bps: float = 0.0  # computed from rolling price

    def is_fresh(self, max_age_ms: float = STALE_MS) -> bool:
        return (time.time() * 1000 - self.timestamp_ms) < max_age_ms


@dataclass
class DataEvent:
    """Events emitted by DataIngestionService for the runner to consume."""

    class Type(Enum):
        SNAPSHOT = auto()  # new market data snapshot
        FALLBACK_TRIGGERED = auto()  # switched to Coinbase
        RECOVERED = auto()  # back on Binance
        ERROR = auto()  # non-fatal error
        STOPPED = auto()  # shutdown complete

    type: Type
    snapshot: MarketSnapshot | None = None
    message: str = ""


# ── Synthetic Momentum Tracker ──────────────────────────────────────────────


class SyntheticMomentumTracker:
    """Sliding-window price momentum tracker.

    Computes drift_bps and tick_momentum (-1..1) from a deque of
    (timestamp, price) ticks. Pure buy pressure → +1.0, sell → -1.0.
    """

    def __init__(self, window_seconds: int = 10) -> None:
        # Pre-allocated ring buffer — avoids GC spikes on Termux
        self.ticks: collections.deque = collections.deque(maxlen=100)
        self.window = window_seconds

    def add_tick(self, price: float) -> None:
        now = time.time()
        self.ticks.append((now, price))
        while self.ticks and self.ticks[0][0] < now - self.window:
            self.ticks.popleft()

    def get_metrics(self) -> dict[str, float]:
        if len(self.ticks) < 2:
            return {"drift_bps": 0.0, "tick_momentum": 0.0}

        first_price = self.ticks[0][1]
        latest_price = self.ticks[-1][1]
        drift_bps = ((latest_price - first_price) / first_price) * 10000

        up_ticks = down_ticks = 0
        for i in range(1, len(self.ticks)):
            diff = self.ticks[i][1] - self.ticks[i - 1][1]
            if diff > 0:
                up_ticks += 1
            elif diff < 0:
                down_ticks += 1

        total = up_ticks + down_ticks
        tick_momentum = (up_ticks - down_ticks) / total if total > 0 else 0.0
        return {
            "drift_bps": round(drift_bps, 2),
            "tick_momentum": round(tick_momentum, 2),
        }


# ── Ingestion Service ────────────��──────────────────────────────────────────


class DataIngestionService:
    """Async stream manager. Connect via connect(), read events via event_queue."""

    def __init__(self) -> None:
        self.state = SourceState.STOPPED
        self.event_queue: asyncio.Queue[DataEvent] = asyncio.Queue()

        self._snapshot = MarketSnapshot()
        self._price_window: list[tuple[float, float]] = []  # (timestamp_s, price)

        self._binance_ws: Any = None
        self._binance_task: asyncio.Task | None = None
        self._coinbase_task: asyncio.Task | None = None
        self._last_binance_event_ms: float = 0.0
        self._recovery_start: float = 0.0
        self._reconnect_delay: float = 1.0
        self._stopped = False
        self._first_snapshot_emitted = False

    # ── Public API ─────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Start ingestion. Returns once the first snapshot is available."""
        self._stopped = False
        self._last_binance_event_ms = time.time() * 1000
        # Binance WS blocked (HTTP 451) — start Coinbase directly
        self.state = SourceState.FALLBACK_COINBASE
        self._coinbase_task = asyncio.create_task(self._coinbase_ws_loop())

        # Wait for first data
        timeout = 15.0
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                evt = await asyncio.wait_for(
                    self.event_queue.get(), timeout=0.5
                )
                if evt.type == DataEvent.Type.SNAPSHOT and evt.snapshot:
                    return
            except asyncio.TimeoutError:
                continue
        raise TimeoutError("DataIngestionService failed to connect within 15s")

    async def stop(self) -> None:
        """Shut down all connections and tasks."""
        self._stopped = True
        self.state = SourceState.STOPPED
        if self._binance_ws:
            try:
                await self._binance_ws.close()
            except Exception:
                pass
        for t in (self._binance_task, self._coinbase_task):
            if t and not t.done():
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
        await self.event_queue.put(
            DataEvent(type=DataEvent.Type.STOPPED, message="Shutdown complete")
        )

    async def get_snapshot(self) -> MarketSnapshot:
        """Return the latest snapshot (thread-safe access via copy)."""
        return self._snapshot

    # ── Binance WebSocket Loop ─────────────────────────────────────────

    async def _binance_loop(self) -> None:
        """Maintain Binance WebSocket connection with reconnect backoff."""
        while not self._stopped:
            try:
                async with websockets.connect(
                    BINANCE_COMBINED, ping_interval=20, ping_timeout=10
                ) as ws:
                    self._binance_ws = ws
                    self._reconnect_delay = 1.0
                    logger.info("Binance WebSocket connected")

                    await self._process_binance_stream(ws)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(
                    "Binance WS error: %s — reconnecting in %.1fs",
                    exc, self._reconnect_delay,
                )
                await self._on_binance_disconnect()

                if self._reconnect_delay < MAX_RECONNECT_DELAY:
                    self._reconnect_delay = min(
                        self._reconnect_delay * 2, MAX_RECONNECT_DELAY
                    )

                if not self._stopped:
                    await asyncio.sleep(self._reconnect_delay)

    async def _process_binance_stream(self, ws: Any) -> None:
        """Process messages from the combined Binance stream."""
        async for raw in ws:
            if self._stopped:
                break

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            now_ms = time.time() * 1000
            self._last_binance_event_ms = now_ms

            # Combined stream wraps in {'stream': ..., 'data': ...}
            data = msg.get("data", msg) if "data" in msg else msg

            stream = msg.get("stream", "")
            is_depth = "depth" in stream or "bids" in data or "asks" in data
            is_trade = "trade" in stream or "Trade" in type(data).__name__

            if is_depth:
                self._handle_binance_depth(data, now_ms)
            elif is_trade:
                self._handle_binance_trade(data, now_ms)

    def _handle_binance_depth(self, data: dict, now_ms: float) -> None:
        """Update order book from Binance depth snapshot."""
        bids_raw = data.get("bids", data.get("b", []))
        asks_raw = data.get("asks", data.get("a", []))

        bids = []
        for b in bids_raw[:20]:
            try:
                p, q = (float(b[0]), float(b[1])) if isinstance(b, list) else (float(b.get("price", 0)), float(b.get("qty", b.get("quantity", 0))))
                if p > 0 and q >= 0:
                    bids.append((p, q))
            except (TypeError, ValueError):
                continue

        asks = []
        for a in asks_raw[:20]:
            try:
                p, q = (float(a[0]), float(a[1])) if isinstance(a, list) else (float(a.get("price", 0)), float(a.get("qty", a.get("quantity", 0))))
                if p > 0 and q >= 0:
                    asks.append((p, q))
            except (TypeError, ValueError):
                continue

        if not bids or not asks:
            return

        best_bid = bids[0][0]
        best_ask = asks[0][0]
        mid = (best_bid + best_ask) / 2.0

        self._snapshot.source = "binance"
        self._snapshot.timestamp_ms = now_ms
        self._snapshot.btc_price = mid
        self._snapshot.bid_depth = bids
        self._snapshot.ask_depth = asks
        self._snapshot.imbalance = self._compute_imbalance(bids, asks)
        tmp = self._snapshot.drift_5m_bps
        self._snapshot.drift_5m_bps = self._compute_drift(mid, now_ms)

        self._emit_snapshot()

        # Detect fallback failure / recovery
        if self.state == SourceState.RECOVERING:
            if self._recovery_start == 0:
                self._recovery_start = now_ms
            elif (now_ms - self._recovery_start) >= RECOVERY_CLEAN_S * 1000:
                self.state = SourceState.CONNECTED_BINANCE
                self._recovery_start = 0
                logger.info("Binance recovered — 5s clean data verified")
                asyncio.ensure_future(
                    self.event_queue.put(
                        DataEvent(type=DataEvent.Type.RECOVERED, message="Binance recovered")
                    )
                )
        elif self.state == SourceState.FALLBACK_COINBASE:
            self.state = SourceState.RECOVERING
            self._recovery_start = now_ms
            logger.info("Binance reconnected — entering recovery window")

    def _handle_binance_trade(self, data: dict, now_ms: float) -> None:
        """Update price from trade (more precise than depth mid)."""
        price_str = data.get("p", data.get("price", ""))
        try:
            price = float(price_str)
        except (TypeError, ValueError):
            return
        if price <= 0:
            return
        self._snapshot.btc_price = price
        self._snapshot.timestamp_ms = now_ms

    async def _on_binance_disconnect(self) -> None:
        """Handle Binance disconnection — trigger fallback if not already."""
        if self.state in (SourceState.CONNECTED_BINANCE, SourceState.RECOVERING):
            self.state = SourceState.FALLBACK_COINBASE
            self._coinbase_task = asyncio.create_task(self._coinbase_ws_loop())
            await self.event_queue.put(
                DataEvent(
                    type=DataEvent.Type.FALLBACK_TRIGGERED,
                    message="Binance disconnected — switching to Coinbase",
                )
            )

    # ── Coinbase Fallback ──────────────────────────────────────────────

    async def _coinbase_ws_loop(self) -> None:
        """Coinbase Advanced Trade WebSocket as dynamic fallback.

        Public ticker channel (no auth) provides real-time price.
        Uses SyntheticMomentumTracker for drift + tick momentum.
        First snapshot always emitted; subsequent ones gated by threshold.
        Kalshi order book fetched on-demand by runner, not in this loop.
        """
        subscribe = json.dumps({
            "type": "subscribe",
            "channel": "ticker",
            "product_ids": ["BTC-USD"],
        })

        logger.info("Coinbase WS fallback (ticker) starting...")
        tracker = SyntheticMomentumTracker(window_seconds=30)

        while not self._stopped:
            if self.state not in (SourceState.FALLBACK_COINBASE, SourceState.RECOVERING):
                break

            try:
                async with websockets.connect(
                    COINBASE_WS_URL, ping_interval=20, ping_timeout=10
                ) as ws:
                    await ws.send(subscribe)
                    logger.info("Coinbase WS subscribed")

                    while not self._stopped:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=10)
                        except asyncio.TimeoutError:
                            continue

                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue

                        if msg.get("type") == "error":
                            logger.warning("Coinbase WS error: %s", msg.get("message", ""))
                            continue
                        if msg.get("type") in ("subscriptions",):
                            continue
                        if msg.get("channel") != "ticker":
                            continue

                        now_ms = time.time() * 1000
                        for evt in msg.get("events", []):
                            evt_type = evt.get("type", "")
                            for tick in evt.get("tickers", []):
                                try:
                                    price = float(tick.get("price", 0))
                                except (TypeError, ValueError):
                                    continue
                                if price <= 0:
                                    continue

                                tracker.add_tick(price)
                                metrics = tracker.get_metrics()

                                drift_old = self._snapshot.drift_5m_bps
                                self._snapshot.source = "coinbase"
                                self._snapshot.timestamp_ms = now_ms
                                self._snapshot.btc_price = price
                                self._snapshot.drift_5m_bps = metrics["drift_bps"]
                                self._snapshot.imbalance = metrics["tick_momentum"]

                                # First snapshot always emitted; rest gated by threshold
                                drift_changed = abs(metrics["drift_bps"] - drift_old) >= MOVEMENT_THRESHOLD_BPS
                                force = not self._first_snapshot_emitted or evt_type == "snapshot"
                                if force or drift_changed:
                                    self._first_snapshot_emitted = True
                                    self._emit_snapshot()

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("Coinbase WS error: %s — reconnecting in 3s", exc)
                await asyncio.sleep(3)

        logger.info("Coinbase WS loop exiting")


    def _compute_tick_imbalance(self, up: int, down: int) -> float:
        """(-1..1): +1 = more up-ticks than down-ticks (buying pressure)."""
        total = up + down
        return round((up - down) / total, 4) if total > 0 else 0.0


    def _state_check(self) -> None:
        """Check if we can transition back from RECOVERING to CONNECTED_BINANCE."""
        age_ms = time.time() * 1000 - self._last_binance_event_ms
        if self.state == SourceState.FALLBACK_COINBASE and age_ms < STALE_MS:
            self.state = SourceState.RECOVERING
            self._recovery_start = time.time() * 1000

    # ── Helpers ────────────────────────────────────────────────────────

    def _compute_imbalance(
        self, bids: list[tuple[float, float]], asks: list[tuple[float, float]]
    ) -> float:
        """(-1..1): +1 = strong buy pressure, -1 = strong sell pressure."""
        bid_vol = sum(q for _, q in bids[:5])
        ask_vol = sum(q for _, q in asks[:5])
        total = bid_vol + ask_vol
        return round((bid_vol - ask_vol) / total, 4) if total > 0 else 0.0

    def _compute_drift(self, price: float, now_ms: float) -> float:
        """5-minute price drift in basis points from rolling window."""
        now_s = now_ms / 1000.0
        self._price_window.append((now_s, price))
        # Keep 5 minutes of history
        cutoff = now_s - 300
        self._price_window = [
            (t, p) for t, p in self._price_window if t >= cutoff
        ]
        if len(self._price_window) < 10:
            return 0.0
        oldest = self._price_window[0][1]
        if oldest <= 0:
            return 0.0
        return round((price - oldest) / oldest * 10_000, 2)  # bps

    def _emit_snapshot(self) -> None:
        asyncio.ensure_future(
            self.event_queue.put(
                DataEvent(type=DataEvent.Type.SNAPSHOT, snapshot=self._snapshot)
            )
        )

    def is_stale(self, max_age_ms: float = STALE_MS) -> bool:
        return (time.time() * 1000 - self._snapshot.timestamp_ms) > max_age_ms
