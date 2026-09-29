"""Two-stage strategy: read the BTC feed first, then pivot to the Kalshi book.

Stage 1 (BTC feed): how far has BTC moved since the window opened, relative to
  how much it normally moves in the time left?  Model BTC as a random walk:
      d      = gap_pct / (sigma_pct_per_min * sqrt(minutes_left))
      p_up   = Phi(d)         (then shrunk toward 0.5 for model humility)
  The window reference price is the average of the 1-minute candle just before
  the window opened (mirrors Kalshi's 60s-average settlement), taken from the
  SAME feed as spot — so exchange basis (USDT vs BRTI) cancels out.

Stage 2 (Kalshi book): compare p_up with what Kalshi charges.
      edge_up   = p_up - yes_ask          edge_down = (1 - p_up) - no_ask
  Trade the better side only if edge >= MIN_EDGE, THEN require the order book
  to be tradeable (spread, depth, price range) and not strongly against us.

Fails closed. Advice only — never places an order.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import book_signal as bs

WINDOW_MINUTES = 15  # KXBTC15M window length
MIN_EDGE = 0.05  # min (fair prob - ask) to act; covers model error
MODEL_SHRINK = 0.85  # pull p toward 0.5 (1.0 = trust the model fully)
MIN_SIGMA_PCT = 0.015  # floor on per-minute volatility (%)
VOL_CANDLES = 30  # candles used to estimate volatility
EDGE_LEVELS = (0.05, 0.10, 0.15)  # edge for conviction 1 / 2 / 3


@dataclass
class PivotDecision:
    direction: str = "pass"
    conviction: int = 0
    should_trade: bool = False
    features: dict[str, Any] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    def summary(self) -> str:
        f = self.features
        core = (
            f"src={f.get('source')} spot={f.get('spot')} gap={f.get('gap_pct')}% "
            f"left={f.get('minutes_left')}m p_up={f.get('p_up')} "
            f"ask(y/n)={f.get('yes_ask')}/{f.get('no_ask')} "
            f"edge(y/n)={f.get('edge_up')}/{f.get('edge_down')}"
        )
        if self.should_trade:
            return f"PIVOT {self.direction.upper()} conv={self.conviction} | {core}"
        return (
            f"PIVOT no trade ({'; '.join(self.reasons) or 'no edge'}) | {core}"
        )


def _phi(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def reference_price(
    klines: list[list[Any]], window_start_ms: int
) -> float | None:
    """Mid of the 1m candle that ended right when the window opened."""
    want = window_start_ms - 60_000
    for k in klines:
        try:
            if int(k[0]) == want:
                return (float(k[1]) + float(k[4])) / 2.0
        except (TypeError, ValueError, IndexError):
            continue
    return None


def sigma_pct_per_min(klines: list[list[Any]]) -> float | None:
    """Std-dev of 1-minute log returns (in %), from completed candles."""
    try:
        closes = [float(k[4]) for k in klines[:-1][-(VOL_CANDLES + 1) :]]
    except (TypeError, ValueError, IndexError):
        return None
    rets = [
        math.log(b / a) * 100
        for a, b in zip(closes, closes[1:])
        if a > 0 and b > 0
    ]
    if len(rets) < 5:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return max(math.sqrt(var), MIN_SIGMA_PCT)


def fair_prob_up(
    gap_pct: float, sigma: float, minutes_left: float
) -> tuple[float, float]:
    """(shrunk probability BTC finishes >= reference, raw z-score)."""
    d = gap_pct / (sigma * math.sqrt(max(minutes_left, 0.25)))
    p = 0.5 + MODEL_SHRINK * (_phi(d) - 0.5)
    return p, d


def evaluate_pivot(
    klines: list[list[Any]] | None,
    source: str,
    window_start_ms: int,
    minutes_left: float,
    yes_ask: float,
    no_ask: float,
    book_features: dict[str, Any] | None,
) -> PivotDecision:
    d = PivotDecision()
    d.features = {
        "source": source,
        "minutes_left": round(minutes_left, 1),
        "yes_ask": round(yes_ask, 3),
        "no_ask": round(no_ask, 3),
    }

    if not klines or len(klines) < 15:
        d.reasons.append("no BTC price data")
        return d

    ref = reference_price(klines, window_start_ms)
    sigma = sigma_pct_per_min(klines)
    if ref is None:
        d.reasons.append("no reference candle for window open")
        return d
    if sigma is None:
        d.reasons.append("not enough candles for volatility")
        return d

    spot = float(klines[-1][4])
    gap_pct = (spot - ref) / ref * 100.0
    p_up, z = fair_prob_up(gap_pct, sigma, minutes_left)

    edge_up = p_up - yes_ask
    edge_down = (1.0 - p_up) - no_ask
    d.features.update(
        {
            "spot": round(spot, 2),
            "reference": round(ref, 2),
            "gap_pct": round(gap_pct, 4),
            "sigma_pct_min": round(sigma, 4),
            "z": round(z, 2),
            "p_up": round(p_up, 3),
            "edge_up": round(edge_up, 3),
            "edge_down": round(edge_down, 3),
        }
    )

    if edge_up >= edge_down:
        d.direction, edge, entry = "up", edge_up, yes_ask
    else:
        d.direction, edge, entry = "down", edge_down, no_ask
    d.conviction = sum(edge >= t for t in EDGE_LEVELS)

    if edge < MIN_EDGE:
        d.reasons.append(f"edge {edge:+.3f} < {MIN_EDGE}")
        return d

    d.reasons.extend(bs.confirm_with_book(d.direction, book_features, entry))
    d.should_trade = not d.reasons
    return d
