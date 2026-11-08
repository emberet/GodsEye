"""
The trailing "ok price" filter of one coin (features.yaml conventions.tracked_swap), one swap at a time: what the
server's TrailingFilter (agent/src/brain/state.ts) must compute for its ring, and what derive.build_prices computes in
SQL for the offline build. spec/golden/filter.json pins the rule on both sides; the tests check this file against
derive.build_prices on random tapes.

    f = TrailingFilter()
    ok = [f.accept(wallet, price, sol, tokens) for wallet, price, sol, tokens in swaps]   # in (ts, slot, id) order

A price is valid when price > 0 (finite), sol >= 0.001 and tokens >= 1. A valid price is ok when
  - it is within 10x of the median of the coin's PREVIOUS 10 VALID prices (inclusive; the first valid price is ok), and
  - it is not "lone": among those 10, no print by another wallet is within 10x of it while at least one by another
    wallet is not (only its own wallet backs its level).
Every valid price enters the window, ok or not, so the filter heals after a real lasting > 10x move: a filter fed only
the prices it accepted would reject everything after a rug forever.
"""
from __future__ import annotations

import math
from collections import deque

from brain.data.derive import MIN_PRICE_SOL, MIN_PRICE_TOKENS, OUTLIER_X, TRAIL_WINDOW


def valid(price, sol, tokens) -> bool:
    try:
        p, s, k = float(price), float(sol), float(tokens)
    except (TypeError, ValueError):
        return False
    return math.isfinite(p) and p > 0 and s >= MIN_PRICE_SOL and k >= MIN_PRICE_TOKENS


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


class TrailingFilter:
    """One coin's filter: the last TRAIL_WINDOW valid prices with their wallets."""

    def __init__(self) -> None:
        self.tail: deque[tuple[float, str]] = deque(maxlen=TRAIL_WINDOW)

    def accept(self, wallet: str, price, sol, tokens) -> bool:
        if not valid(price, sol, tokens):
            return False
        p = float(price)
        prev = list(self.tail)
        self.tail.append((p, wallet))
        if not prev:
            return True
        rm = p / _median([x for x, _ in prev])
        if not (1.0 / OUTLIER_X <= rm <= OUTLIER_X):
            return False
        others = [x for x, w in prev if w != wallet]
        near = [x for x in others if p / OUTLIER_X <= x <= p * OUTLIER_X]
        return not (others and not near)


def ok_flags(rows: list[dict]) -> list[bool]:
    """ok of each swap of ONE coin, rows {wallet, price, sol, tokens} in (ts, slot, id) order."""
    f = TrailingFilter()
    return [f.accept(r["wallet"], r["price"], r["sol"], r["tokens"]) for r in rows]
