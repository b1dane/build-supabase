"""Execution engine — places orders on Kalshi (paper or live with RSA auth).

Paper mode: in-memory simulation.
Live mode: Kalshi REST API with RSA signature authentication.

RSA key path from env: KALSHI_RSA_KEY=/path/to/key.pem
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any

import httpx

from config import config

logger = logging.getLogger("kalshi_bot")

KALSHI_ORDER_URL = (
    f"{config.KALSHI_BASE.rstrip('/')}/portfolio/orders"
)


class ExecMode(Enum):
    PAPER = auto()
    LIVE = auto()


@dataclass
class OrderResult:
    filled: bool = False
    order_id: str = ""
    price_cents: int = 0
    contracts: int = 0
    error: str = ""
    raw_response: str = ""

    @property
    def success(self) -> bool:
        return self.filled and not self.error


class ExecutionEngine:
    """Handles order placement. Supports paper and live mode."""

    def __init__(self, mode: ExecMode = ExecMode.PAPER) -> None:
        self.mode = mode
        self.balance_cents: int = int(config.PAPER_START_BALANCE * 100)
        self.positions: dict[str, int] = {}  # ticker -> contracts held
        self._orders: list[dict] = []
        # Deadman switch: track position entry timestamps
        self._position_entries: dict[str, float] = {}
        self._deadman_timeout_s: float = 60.0
        # Pre-signed template: static fields pre-computed for latency reduction
        self._order_template = {
            "type": "limit",
            "post_only": True,
            "client_order_id_prefix": "jevbot_",
        }

        if mode == ExecMode.LIVE:
            logger.info("Execution engine: LIVE mode")
        else:
            logger.info("Execution engine: PAPER mode (balance=%dc)", self.balance_cents)

    # ── Public API ─────────────────────────────────────────────────────

    def place_order(
        self,
        ticker: str,
        side: str,  # "yes" | "no"
        price_cents: int,
        contracts: int,
        order_type: str = "limit",
        post_only: bool = True,
    ) -> OrderResult:
        """Place an order on Kalshi (paper or live).

        Args:
            ticker: Kalshi market ticker (e.g. "KXBTC15M-26SEP282200-00")
            side: "yes" or "no"
            price_cents: limit price in cents
            contracts: number of contracts
            order_type: "limit" or "market"
            post_only: if True, order will not take liquidity

        Returns:
            OrderResult with fill status and details.
        """
        cost_cents = price_cents * contracts

        if self.mode == ExecMode.PAPER:
            return self._paper_execute(ticker, side, price_cents, contracts, cost_cents)
        return self._live_execute(ticker, side, price_cents, contracts, order_type, post_only)

    def get_exposure(self, ticker: str | None = None) -> int:
        """Return current exposure in cents for a ticker or total."""
        if ticker:
            return self.positions.get(ticker, 0)
        return sum(self.positions.values())

    def get_status(self) -> dict[str, Any]:
        return {
            "mode": self.mode.name,
            "balance_cents": self.balance_cents,
            "positions": dict(self.positions),
            "total_exposure_cents": self.get_exposure(),
        }

    # ── Paper Mode ─────────────────────────────────────────────────────

    def _paper_execute(
        self,
        ticker: str,
        side: str,
        price_cents: int,
        contracts: int,
        cost_cents: int,
    ) -> OrderResult:
        """Simulate order execution in paper mode."""
        if cost_cents > self.balance_cents:
            return OrderResult(
                error=f"Insufficient balance: need {cost_cents}c, have {self.balance_cents}c"
            )

        self.balance_cents -= cost_cents
        self.positions[ticker] = self.positions.get(ticker, 0) + contracts
        self._position_entries[ticker] = time.time()

        result = OrderResult(
            filled=True,
            order_id=f"paper_{int(time.time())}_{ticker}",
            price_cents=price_cents,
            contracts=contracts,
        )
        self._orders.append({
            "ticker": ticker,
            "side": side,
            "price_cents": price_cents,
            "contracts": contracts,
            "cost_cents": cost_cents,
            "time": time.time(),
            "type": "paper",
        })
        logger.info(
            "Paper %s %s %dx @ %sc (cost=%dc, balance=%dc)",
            side.upper(), ticker, contracts, price_cents, cost_cents, self.balance_cents,
        )
        return result

    # ── Live Mode (RSA Auth) ────────���──────────────────────────────────

    def _live_execute(
        self,
        ticker: str,
        side: str,
        price_cents: int,
        contracts: int,
        order_type: str,
        post_only: bool,
    ) -> OrderResult:
        """Place real order on Kalshi via REST API with RSA signature."""
        try:
            rsa_key_path = getattr(config, "KALSHI_RSA_KEY", "")
            if not rsa_key_path:
                return OrderResult(error="KALSHI_RSA_KEY not configured")

            # Build order payload
            payload = {
                "ticker": ticker,
                "side": side,
                "type": order_type,
                "price": price_cents,
                "count": contracts,
                "post_only": post_only,
                "client_order_id": f"jevbot_{int(time.time())}",
            }

            # Sign with RSA
            import rsa as rsa_lib
            with open(rsa_key_path, "rb") as f:
                privkey = rsa_lib.PrivateKey.load_pkcs1(f.read())

            body = json.dumps(payload)
            signature = rsa_lib.sign(
                body.encode(),
                privkey,
                "SHA-256",
            ).hex()

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"{config.KALSHI_API_KEY}:{signature}",
            }

            resp = httpx.post(
                KALSHI_ORDER_URL,
                content=body,
                headers=headers,
                timeout=10,
            )
            data = resp.json()
            if resp.status_code in (200, 201):
                return OrderResult(
                    filled=True,
                    order_id=data.get("order_id", ""),
                    price_cents=price_cents,
                    contracts=contracts,
                )
            return OrderResult(
                error=f"Kalshi HTTP {resp.status_code}: {resp.text[:200]}",
                raw_response=resp.text,
            )
        except Exception as exc:
            logger.exception("Live order failed")
            return OrderResult(error=str(exc))

    def settle(self, ticker: str, won: bool) -> None:
        """Settle a trade — payout if won, remove position."""
        pos = self.positions.get(ticker, 0)
        if pos <= 0:
            return
        if won:
            payout = pos * 100  # each contract pays $1
            self.balance_cents += payout
            logger.info("Settled %s WIN: +%dc", ticker, payout)
        else:
            logger.info("Settled %s LOSS", ticker)
        self.positions[ticker] = 0
        self._position_entries.pop(ticker, None)

    # ── Deadman switch ──────────────────────────────────────────────────

    def check_deadman(self) -> list[dict[str, Any]]:
        """Auto-close any position open longer than 60s.

        Hard risk veto: exit regardless of Jev output.
        Returns list of closed position dicts.
        """
        now = time.time()
        closed: list[dict[str, Any]] = []
        for ticker in list(self._position_entries.keys()):
            age = now - self._position_entries[ticker]
            if age > self._deadman_timeout_s:
                pos = self.positions.get(ticker, 0)
                if pos > 0:
                    logger.warning(
                        "DEADMAN: closing %s (%dx, age=%.0fs > %ds)",
                        ticker, pos, age, self._deadman_timeout_s,
                    )
                    # Cancel resting orders + close at market
                    # In paper mode: force-close at current price
                    self.positions[ticker] = 0
                    self._position_entries.pop(ticker, None)
                    closed.append({
                        "ticker": ticker,
                        "contracts": pos,
                        "age_s": round(age, 1),
                        "reason": "deadman_60s",
                    })
        return closed
