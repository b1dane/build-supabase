"""Configuration — all secrets from environment, nothing hardcoded."""
from __future__ import annotations

import os


class Config:
    """Reads from environment at construction time. No hardcoded secrets."""

    # Jev / TypeSafe AI
    JEV_API_KEY: str = ""
    JEV_API_URL: str = "https://api.typesafe.ai/v1/systemone"

    # Kalshi
    KALSHI_SERIES: str = "KXBTC15M"
    KALSHI_BASE: str = "https://api.elections.kalshi.com/trade-api/v2"

    # Supabase (optional — decisions degrade gracefully without it)
    SUPABASE_URL: str = ""
    SUPABASE_KEY: str = ""

    # Paper trading
    PAPER_START_BALANCE: float = 10.0
    PAPER_MAX_FIRST: float = 5.0
    PAPER_PROGRESSION_GATE: float = 0.30
    PAPER_HARD_STOP: float = 0.75

    def __init__(self) -> None:
        self.JEV_API_KEY = os.environ.get("JEV_API_KEY", "")
        self.JEV_API_URL = os.environ.get(
            "JEV_API_URL", "https://api.typesafe.ai/v1/systemone"
        )
        self.KALSHI_SERIES = os.environ.get("KALSHI_SERIES", "KXBTC15M")
        self.KALSHI_BASE = os.environ.get(
            "KALSHI_BASE", "https://api.elections.kalshi.com/trade-api/v2"
        )
        self.SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
        self.SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
        self.PAPER_START_BALANCE = float(
            os.environ.get("PAPER_START_BALANCE", "10.0")
        )
        self.PAPER_MAX_FIRST = float(os.environ.get("PAPER_MAX_FIRST", "5.0"))
        self.PAPER_PROGRESSION_GATE = float(
            os.environ.get("PAPER_PROGRESSION_GATE", "0.30")
        )
        self.PAPER_HARD_STOP = float(os.environ.get("PAPER_HARD_STOP", "0.75"))

    @property
    def jev_configured(self) -> bool:
        return bool(self.JEV_API_KEY)

    def __repr__(self) -> str:
        return (
            f"Config(series={self.KALSHI_SERIES}, "
            f"jev={'yes' if self.jev_configured else 'no'}, "
            f"supabase={'yes' if self.SUPABASE_URL else 'no'})"
        )


config = Config()
