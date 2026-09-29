"""Paper trading executor — simulates trades in-memory.

Rules (from server-side limits):
  - First bet <= $5 max
  - +30% progression gate
  - +75% hard stop (never risk last 25%)
  - Never negative balance
  - Position size: conviction-based (1=min, 2=medium, 3=max)
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any

from config import config

logger = logging.getLogger("kalshi_bot")

# Contract face value
CONTRACT_PAYOUT = 1.00

# Position scaling by conviction level
POSITION_FRACTIONS = {1: 0.20, 2: 0.40, 3: 0.60}


@dataclass
class TradeRecord:
    event_ticker: str
    market_ticker: str
    direction: str  # "yes" | "no"
    conviction: int
    entry_price: float
    contracts: int
    cost: float
    opened_at: float
    target_price: float
    settled: bool = False
    was_correct: bool | None = None
    pnl: float | None = None
    settled_at: str | None = None


class PaperExecutor:
    def __init__(self) -> None:
        self.balance: float = config.PAPER_START_BALANCE
        self.peak_balance: float = self.balance
        self.trades: list[TradeRecord] = []
        self.total_trades: int = 0
        self.wins: int = 0
        self.losses: int = 0

    # ── Properties ──────────────────────────────────────────────────────

    @property
    def open_count(self) -> int:
        return sum(1 for t in self.trades if not t.settled)

    @property
    def win_rate(self) -> float:
        total = self.wins + self.losses
        return (self.wins / total * 100.0) if total > 0 else 0.0

    @property
    def can_trade(self) -> tuple[bool, str]:
        """(allowed, reason). Checks balance, drawdown, and open positions."""
        if self.balance <= 0.01:
            return False, "balance depleted"
        if self.open_count >= 2:
            return False, f"{self.open_count} open positions (max 2)"
        drawdown = (
            1.0 - self.balance / self.peak_balance
            if self.peak_balance > 0
            else 0.0
        )
        if drawdown >= config.PAPER_HARD_STOP:
            return False, f"drawdown {drawdown:.0%} >= {config.PAPER_HARD_STOP:.0%} hard stop"
        return True, "ok"

    # ── Trade execution ─────────────────────────────────────────────────

    def execute_trade(
        self,
        event_ticker: str,
        market_ticker: str,
        direction: str,
        conviction: int,
        yes_price: float,
        no_price: float,
        target_price: float,
    ) -> dict[str, Any] | None:
        """Execute a paper trade. Returns trade dict or None.

        direction is "up" or "down" — mapped to "yes"/"no" Kalshi side.
        """
        if direction == "up":
            side, entry_price = "yes", yes_price
        elif direction == "down":
            side, entry_price = "no", no_price
        else:
            logger.warning("Invalid direction: %s", direction)
            return None

        allowed, reason = self.can_trade
        if not allowed:
            logger.info("Risk gate: %s", reason)
            return None

        if not (0.01 < entry_price < 0.99):
            logger.warning("Bad entry price: %.4f", entry_price)
            return None

        # Position sizing
        frac = POSITION_FRACTIONS.get(conviction, 0.20)
        # First trade cap
        if self.total_trades == 0:
            max_first = config.PAPER_MAX_FIRST
            budget = min(self.balance * frac, max_first)
        else:
            budget = self.balance * frac

        # Progression gate: can't risk more than +30% of previous max bet
        if self.total_trades > 0:
            prev_max = max(
                t.cost for t in self.trades
            )
            budget = min(budget, prev_max * (1.0 + config.PAPER_PROGRESSION_GATE))

        contracts = int(budget / entry_price)
        cost = round(contracts * entry_price, 2)

        if contracts < 1 or cost <= 0.0:
            logger.info("Trade too small: budget=%.2f entry=%.4f", budget, entry_price)
            return None
        if cost > self.balance:
            logger.info("Insufficient balance: need %.2f have %.2f", cost, self.balance)
            return None

        trade = TradeRecord(
            event_ticker=event_ticker,
            market_ticker=market_ticker,
            direction=side,
            conviction=conviction,
            entry_price=entry_price,
            contracts=contracts,
            cost=cost,
            opened_at=time.time(),
            target_price=target_price,
        )
        self.trades.append(trade)
        self.balance = round(self.balance - cost, 2)
        self.total_trades += 1
        return {
            "direction": side,
            "market_ticker": market_ticker,
            "contracts": contracts,
            "entry_price": entry_price,
            "cost": cost,
            "conviction": conviction,
        }

    # ── Settlement ──────────────────────────────────────────────────────

    def check_settlements(self) -> list[dict[str, Any]]:
        """Check all open trades for settlement. Returns settled trade dicts."""
        settled: list[dict[str, Any]] = []
        for t in self.trades:
            if t.settled:
                continue
            # In paper mode, we don't have real settlement info.
            # This is a placeholder — real settlement checking would poll
            # Kalshi API for the market result.
            pass
        return settled

    def settle_trade(self, trade: TradeRecord, won: bool) -> dict[str, Any]:
        """Manually settle a trade (called by runner when Kalshi result known)."""
        trade.settled = True
        trade.was_correct = won
        if won:
            payout = trade.contracts * CONTRACT_PAYOUT
            trade.pnl = round(payout - trade.cost, 2)
            self.balance = round(self.balance + payout, 2)
            self.wins += 1
        else:
            trade.pnl = round(-trade.cost, 2)
            self.losses += 1
        trade.settled_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        if self.balance > self.peak_balance:
            self.peak_balance = self.balance

        return {
            "event_ticker": trade.event_ticker,
            "market_ticker": trade.market_ticker,
            "direction": trade.direction,
            "conviction": trade.conviction,
            "yes_price_at_entry": trade.entry_price,
            "no_price_at_entry": 1.0 - trade.entry_price if trade.direction == "no" else 0.0,
            "target_price": trade.target_price,
            "settled": True,
            "was_correct": won,
            "pnl": trade.pnl,
            "settled_at": trade.settled_at,
        }

    def get_status_summary(self) -> dict[str, Any]:
        return {
            "balance": round(self.balance, 2),
            "peak_balance": round(self.peak_balance, 2),
            "drawdown_pct": round(
                (1.0 - self.balance / self.peak_balance) * 100
                if self.peak_balance > 0
                else 0.0,
                1,
            ),
            "total_trades": self.total_trades,
            "open_positions": self.open_count,
            "wins": self.wins,
            "losses": self.losses,
            "win_rate": round(self.win_rate, 1),
        }
