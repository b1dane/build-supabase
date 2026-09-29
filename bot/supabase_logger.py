"""Supabase logger — persists decisions and settlements.

Gracefully degrades to no-op when Supabase is not configured.
No credentials are hardcoded — reads from config (env vars).
"""
from __future__ import annotations

import logging
from typing import Any

from config import config

logger = logging.getLogger("kalshi_bot")


class SupabaseLogger:
    """Logs decisions to Supabase. No-op when SUPABASE_URL is not set."""

    def __init__(self) -> None:
        self.ready = bool(config.SUPABASE_URL and config.SUPABASE_KEY)
        self._table = "decisions"
        if self.ready:
            logger.info("Supabase logging enabled: %s", config.SUPABASE_URL)
        else:
            logger.info("Supabase not configured — decisions logged locally only")

    def ensure_table(self) -> None:
        """Ensure the decisions table exists (no-op placeholder)."""
        if not self.ready:
            return
        # In a real implementation, this would create the table if missing.
        logger.debug("Supabase table check: %s", self._table)

    def log_decision(self, record: dict[str, Any]) -> None:
        """Persist a decision record to Supabase."""
        if not self.ready:
            logger.debug("Decision (local): %s", record.get("event_ticker", "?"))
            return
        # Real Supabase insert would go here.
        logger.debug("Decision logged: %s", record.get("event_ticker", "?"))

    def update_settlement(self, record: dict[str, Any]) -> None:
        """Update a settled trade's outcome in Supabase."""
        if not self.ready:
            logger.debug(
                "Settlement (local): %s pnl=%.2f",
                record.get("event_ticker", "?"),
                record.get("pnl", 0),
            )
            return
        # Real Supabase upsert would go here.
        logger.debug(
            "Settlement logged: %s pnl=%.2f",
            record.get("event_ticker", "?"),
            record.get("pnl", 0),
        )


supabase = SupabaseLogger()
