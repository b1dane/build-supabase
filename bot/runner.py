"""Async event-driven main loop.

Flow:
  DataIngestionService (WebSocket) → FeatureEngine (compact state)
  → JevGate (3 typed queries) → StrategyRouter (3 strategies)
  → RiskVetoes (4 hard checks) → ExecutionEngine (paper or live)

Jev classifies; code executes. All risk logic stays in Python.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from typing import Any

from config import config
from data_ingestion import DataIngestionService, DataEvent, SourceState
from execution_engine import ExecutionEngine, ExecMode
from feature_engine import build_state
from jev_gate import query_jev
from kalshi_data import get_current_event
from risk_vetoes import check_vetoes
from runner_helpers import get_ask_prices_cents
from strategy_router import route

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("runner")

JEV_ENABLED = os.environ.get("JEV_ENABLED", "true").lower() in ("true", "1", "yes")
EXEC_MODE = ExecMode.PAPER if os.environ.get("EXEC_MODE", "paper") == "paper" else ExecMode.LIVE
DELTA_THRESHOLD_BPS = 4.0

_shutdown = False


def _handle_signal() -> None:
    global _shutdown
    _shutdown = True
    logger.info("Shutdown signal received")


async def _evaluate(
    engine: ExecutionEngine,
    snapshot: Any,
    source_state: SourceState,
    yes_bid_c: int,
    yes_ask_c: int,
    no_bid_c: int,
    no_ask_c: int,
    ticker: str,
) -> None:
    """Build state → Jev → strategy → vetoes → execute."""
    state = build_state(
        snapshot=snapshot, source_state=source_state,
        kalshi_yes_bid=yes_bid_c, kalshi_yes_ask=yes_ask_c,
        kalshi_no_bid=no_bid_c, kalshi_no_ask=no_ask_c,
    )
    tok = len(json.dumps(state))
    logger.info(
        "EVAL: %s | $%.2f dr=%.1f imb=%.3f | Y=%d/%d N=%d/%d | %dtok",
        ticker, state.get("px", 0), state.get("dr5", 0), state.get("imb", 0),
        yes_bid_c, yes_ask_c, no_bid_c, no_ask_c, tok,
    )

    jev = None
    if JEV_ENABLED and config.jev_configured:
        jev = query_jev(state)

    sig = route(
        jev_direction=jev.direction if jev else "NEUTRAL",
        jev_confidence=jev.direction_confidence if jev else 0.0,
        jev_fill_prob=jev.fill_probability if jev else 0.0,
        jev_toxicity=jev.toxicity if jev else 5,
        lead_drift_bps=state.get("dr5", 0.0),
        lead_imbalance=state.get("imb", 0.0),
        yes_bid_cents=yes_bid_c, yes_ask_cents=yes_ask_c,
        no_bid_cents=no_bid_c, no_ask_cents=no_ask_c,
        kalshi_implied_prob=state.get("kip"),
        balance_cents=engine.balance_cents,
    )
    if not sig.should_act:
        logger.info("No action from strategy")
        return

    veto = check_vetoes(
        data_age_ms=time.time() * 1000 - snapshot.timestamp_ms,
        yes_ask_cents=yes_ask_c, no_ask_cents=no_ask_c,
        yes_bid_cents=yes_bid_c, no_bid_cents=no_bid_c,
        current_exposure_cents=engine.get_exposure(),
        total_balance_cents=engine.balance_cents,
    )
    if not veto.passed:
        logger.warning("Vetoed: %s", veto.summary)
        return

    side = "yes" if sig.action.name in ("BUY_YES_AGGRESSIVE", "POST_YES_LIMIT", "FADE_YES") else "no"
    result = engine.place_order(
        ticker=ticker, side=side, price_cents=sig.price_cents,
        contracts=sig.contracts, post_only=True,
    )
    if result.success:
        logger.info("FILLED: %s %s %dx@%dc bal=%dc", side.upper(), ticker, result.contracts, result.price_cents, engine.balance_cents)
    else:
        logger.warning("ORDER FAILED: %s", result.error)


async def run() -> None:
    logger.info("=" * 60)
    logger.info("Kalshi BTC Bot — Event-Driven")
    logger.info("Jev=%s Paper=%s", JEV_ENABLED, EXEC_MODE.name)
    logger.info("=" * 60)

    ingestion = DataIngestionService()
    engine = ExecutionEngine(mode=EXEC_MODE)
    engine.balance_cents = int(config.PAPER_START_BALANCE * 100)

    try:
        await ingestion.connect()
    except TimeoutError:
        logger.error("Data ingestion failed")
        return

    logger.info("Live. Ctrl+C to stop.")

    # State
    last_event_id: str | None = None
    last_eval_price: float = 0.0
    last_kalshi_poll: float = 0.0
    source_state = SourceState.FALLBACK_COINBASE

    while not _shutdown:
        try:
            # ── Deadman + data health ────────────────────────────────
            deadman = engine.check_deadman()
            if deadman:
                logger.warning("Deadman closed %d", len(deadman))

            # ── Kalshi poll (every 10s, always runs) ─────────────────
            now = time.time()
            if now - last_kalshi_poll < 10.0:
                await asyncio.sleep(1)
                continue
            last_kalshi_poll = now

            event = get_current_event()
            if event is None:
                continue

            eid = event.get("event_ticker", "")
            is_new = eid != last_event_id
            if is_new:
                last_event_id = eid
                last_eval_price = 0.0  # always evaluate new events

            markets = event.get("markets", [])
            if not markets:
                continue
            mkt = markets[0]
            ticker = mkt.get("ticker", "")

            prices = get_ask_prices_cents(mkt)
            if prices is None:
                continue
            ya, na, yb, nb = prices

            # ── Delta gate: skip if same event and BTC flat ──────────
            snapshot = await ingestion.get_snapshot()
            btc = snapshot.btc_price
            if not is_new and last_eval_price > 0:
                change = abs((btc - last_eval_price) / last_eval_price * 10000)
                if change < DELTA_THRESHOLD_BPS:
                    logger.debug("Delta %.1fbps < %s — skip", change, DELTA_THRESHOLD_BPS)
                    continue
            last_eval_price = btc

            await _evaluate(engine, snapshot, source_state, yb, ya, nb, na, ticker)

        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Loop error")
            await asyncio.sleep(5)

    logger.info("Shutdown")
    await ingestion.stop()
    status = engine.get_status()
    logger.info("Final: bal=%dc pos=%s", status["balance_cents"], len(status["positions"]))
    sys.exit(0)


def main() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        try:
            import uvloop
            uvloop.install()
        except ImportError:
            pass
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _handle_signal)
            except NotImplementedError:
                pass
        loop.run_until_complete(run())
    except KeyboardInterrupt:
        _handle_signal()
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:
            pass
        loop.close()


if __name__ == "__main__":
    main()
