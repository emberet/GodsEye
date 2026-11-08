"""
The swap tape the simulator replays: every tracked swap of a set of mints over a time range, with the TRAILING ok-price
filter (below), the insert-time proxy (ins_t) and vectorised lookups:

    tape = load_tape(con, mints, start, end)        # duckdb: wallet_swaps (+archive) with ins_steps
    i = tape.last_ok(mint_code, t_ms)               # ok-row index of the last ok print at or before t (-1: none)
    mid, depth = tape.mid_at(i)                     # model.ts midAt: fee-free mid with the print's own impact

Arrays are sorted by (mint, t, slot, id). Times are integer ms since T0_MS. A lookup key packs (mint code, time) into
one int64 so one np.searchsorted answers per-mint questions for a whole batch.

The ok flag is the causal one of features.yaml (derive.build_prices `ok`, brain.features.prices): valid = price > 0,
sol >= 0.001 and tokens >= 1; ok = valid, within 10x of the median of the mint's previous 10 valid prices, and not lone.
The mirror ledger uses exactly that flag (features.yaml cp_*). The environment's tape (env_filter, the default) also
rejects a print out of range of the level set by material prints (sol >= 0.01) only (_material_ok): some bots' dust buys
are stored in the wrong units (1000x, e.g. 0.001 SOL at 1.6e-4 among prints at 1.6e-7) in bursts that fill the 10-price
window, and B4's 1-minute exit then sold at the 20x cap on them (the top winners of the first run). It only rejects: the
environment's ok prints are a subset of the spec's.

Prices come from any tracked wallet's buys and sells (DATA.md pitfall 2): a coin's tape goes quiet when tracked wallets
stop trading it, which is how a rug looks on it. Two clocks: block time (ts; the environment's fills, marks and valuations
and the simulator's whole exit state and gates, "as if live": sim.yaml insert_time) and insert time (ins_t < t, the
features.yaml INSERT-TIME RULE: known_* lookups and flow(clock="insert"), for point-in-time features).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from brain.data.derive import MIN_PRICE_SOL, MIN_PRICE_TOKENS, OUTLIER_X, TRAIL_WINDOW
from brain.data.loaders import sql_str
from brain.sim.model import FALLBACK_LOOKBACK, MAX_DEPTH, MAX_IMPACT, MIN_DEPTH, MIN_DEPTH_PAIRS, PAIR_MAX_GAP_MS, PAIR_MIN_MOVE

T0_MS = 1_700_000_000_000  # time origin of the int64 ms arrays (2023-11)
SHIFT = 42                 # key = mint << 42 | t: t < 2^42 ms (139 years), mint codes < 2^21
INF_T = np.int64(2**62)
JUDGE_MIN_SOL = 0.01       # env filter: only prints this large set the level ...
JUDGE_LOOKBACK = 40        # ... found among this many previous valid prints of the mint ...
JUDGE_MIN_N = 3            # ... and at least this many of them, else derive's window


def to_ms(ts) -> np.ndarray:
    """Timestamps (pandas / datetime64 / epoch seconds) -> int64 ms since T0_MS."""
    s = pd.Series(ts)
    if pd.api.types.is_numeric_dtype(s):
        return (s.to_numpy(np.float64) * 1000).round().astype(np.int64) - T0_MS
    return (pd.to_datetime(s, utc=True).dt.as_unit("ms").astype("int64")).to_numpy() - T0_MS  # any resolution (us from duckdb)


def key(mint, t) -> np.ndarray:
    return (np.asarray(mint, dtype=np.int64) << SHIFT) | np.asarray(t, dtype=np.int64)


def trailing_ok(mint: np.ndarray, price: np.ndarray, sol: np.ndarray, tokens: np.ndarray | None = None,
                wallet: np.ndarray | None = None, env: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """
    (valid, ok) per row of rows sorted by (mint, time): the causal ok flag of features.yaml conventions.tracked_swap
    (derive.build_prices `ok`, brain.features.prices.TrailingFilter). valid = price > 0, sol >= MIN_PRICE_SOL and
    tokens >= MIN_PRICE_TOKENS; ok = valid, within OUTLIER_X of the median of the mint's previous TRAIL_WINDOW valid
    prices (whether they passed or not, so it heals after a real lasting > 10x move), and not lone (among those, no print
    by another wallet is within OUTLIER_X of it while at least one by another wallet is not). Without `tokens` there is
    no token floor and without `wallet` no lone rule (hand-built tapes).
    env=True: the environment's version, which on top rejects a print that is out of range of the level set by material
    prints only (_material_ok).
    """
    valid = np.isfinite(price) & (price > 0) & (sol >= MIN_PRICE_SOL)
    if tokens is not None:
        valid &= tokens >= MIN_PRICE_TOKENS
    ok = valid.copy()
    vi = np.flatnonzero(valid)
    if len(vi) == 0:
        return valid, ok
    vp = price[vi]
    vm = mint[vi]
    vw = np.asarray(wallet)[vi].astype(np.int64) if wallet is not None else None
    W = TRAIL_WINDOW
    for lo in range(0, len(vi), 1_000_000):
        hi = min(len(vi), lo + 1_000_000)
        a = max(0, lo - W)
        p = np.r_[np.full(W - (lo - a), np.nan), vp[a:hi]]
        m = np.r_[np.full(W - (lo - a), -1), vm[a:hi]]
        win = np.lib.stride_tricks.sliding_window_view(p, W + 1)[:, :W]
        wm = np.lib.stride_tricks.sliding_window_view(m, W + 1)
        same = wm[:, :W] == wm[:, W:W + 1]
        w = np.where(same, win, np.nan)
        has = same.any(axis=1)
        x = vp[lo:hi]
        with np.errstate(all="ignore"):
            med = np.nanmedian(np.where(has[:, None], w, 1.0), axis=1)
            rm = x / med
        good = ~has | ((rm >= 1.0 / OUTLIER_X) & (rm <= OUTLIER_X))
        if vw is not None:
            ww = np.lib.stride_tricks.sliding_window_view(np.r_[np.full(W - (lo - a), -1), vw[a:hi]], W + 1)
            other = same & (ww[:, :W] != ww[:, W:W + 1])
            near = other & (win >= x[:, None] / OUTLIER_X) & (win <= x[:, None] * OUTLIER_X)
            good &= ~((other & ~near).any(axis=1) & ~near.any(axis=1))
        ok[vi[lo:hi]] = good
    if env:
        ok[vi] &= _material_ok(vm, sol[vi], vp, ok[vi])
    return valid, ok


def _material_ok(vm: np.ndarray, vs: np.ndarray, vp: np.ndarray, ok0: np.ndarray, chunk: int = 100_000) -> np.ndarray:
    """
    The material-level check over valid prints: within OUTLIER_X of the median of the mint's previous TRAIL_WINDOW valid
    prints of at least JUDGE_MIN_SOL (looked for in the last JUDGE_LOOKBACK valid prints); with fewer than JUDGE_MIN_N of
    them, ok0. Dust is judged and never judges, so a burst of dust prints in the wrong units by several wallets (which
    the lone rule does not catch) cannot become the level. trailing_ok ANDs it with the spec flag: it only rejects. A real
    lasting move heals after 6 material prints at the new level (rugs and dumps are material sells).
    """
    n = len(vp)
    out = ok0.copy()
    W, K = JUDGE_LOOKBACK, TRAIL_WINDOW
    for lo in range(0, n, chunk):
        hi = min(n, lo + chunk)
        a = max(0, lo - W)
        pad = W - (lo - a)
        p = np.r_[np.full(pad, np.nan), vp[a:hi]]
        m = np.r_[np.full(pad, -1), vm[a:hi]]
        big = np.r_[np.zeros(pad, bool), vs[a:hi] >= JUDGE_MIN_SOL]
        sp = np.lib.stride_tricks.sliding_window_view(p, W + 1)[:, :W]
        sm = np.lib.stride_tricks.sliding_window_view(m, W + 1)
        sb = np.lib.stride_tricks.sliding_window_view(big, W + 1)[:, :W]
        cand = (sm[:, :W] == sm[:, W:]) & sb
        keep = cand & (np.cumsum(cand[:, ::-1], axis=1)[:, ::-1] <= K)   # the K most recent material prints
        has = keep.sum(axis=1) >= JUDGE_MIN_N
        with np.errstate(all="ignore"):
            med = np.nanmedian(np.where(keep, sp, np.nan)[has], axis=1)
            r = vp[lo:hi][has] / med
        seg = out[lo:hi]
        seg[has] = (r >= 1.0 / OUTLIER_X) & (r <= OUTLIER_X)
    return out


@dataclass
class SwapTape:
    mints: np.ndarray            # code -> mint address
    wallets: np.ndarray          # code -> wallet address
    id: np.ndarray
    mint: np.ndarray             # int32 codes
    t: np.ndarray                # int64 ms since T0_MS
    wallet: np.ndarray           # int32 codes
    side: np.ndarray             # int8: +1 buy, -1 sell
    sol: np.ndarray
    price: np.ndarray
    tokens: np.ndarray
    bal: np.ndarray              # token_balance_before
    ins: np.ndarray              # int64 ms since T0_MS: insert-time proxy
    ok: np.ndarray
    fee_bps: float = 100.0
    default_depth: float = 30.0
    depth_window_ms: int = 600_000
    data_end: int = 2**62        # ms since T0_MS: nothing is known after it (censoring)
    outage_h: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))  # masked hour starts (ms since T0_MS)
    insert_index: bool = True    # build the insert-order lookups (known_* / flow(clock="insert")); off saves memory

    def __post_init__(self):
        self.mint_code = {m: i for i, m in enumerate(self.mints)}
        self.wallet_code = {w: i for i, w in enumerate(self.wallets)}
        self.okr = np.flatnonzero(self.ok)                       # ok row -> swap row
        self.t_key = key(self.mint.astype(np.int64), self.t)      # every swap, block-time order
        self.mint_first_t = np.full(len(self.mints), INF_T, dtype=np.int64)  # earliest ts of each mint on the tape
        np.minimum.at(self.mint_first_t, self.mint.astype(np.int64), self.t)
        self.ok_mint = self.mint[self.okr].astype(np.int64)
        self.ok_t = self.t[self.okr]
        self.ok_key = key(self.ok_mint, self.ok_t)
        self.ok_price = self.price[self.okr]
        self.ok_sol = self.sol[self.okr]
        self.ok_side = self.side[self.okr]
        f = self.fee_bps / 1e4
        self.ok_mid = np.where(self.ok_side > 0, self.ok_price / (1 + f), self.ok_price / (1 - f))
        n = len(self.okr)
        self.ok_first = np.zeros(n, dtype=np.int64)              # first ok row of the same mint
        if n:
            starts = np.flatnonzero(np.r_[True, self.ok_mint[1:] != self.ok_mint[:-1]])
            self.ok_first = np.repeat(starts, np.diff(np.r_[starts, n]))
        self._pairs()
        self.depth = np.full(n, np.nan)
        if not self.insert_index:
            return
        # insert order (features): rows sorted by (mint, ins, t)
        self.io = np.lexsort((self.t, self.ins, self.mint))
        self.io_key = key(self.mint[self.io].astype(np.int64), self.ins[self.io])
        # running min of ts over insert order per mint (first tracked swap known at t; gate young_amm)
        big = np.int64(1) << SHIFT
        if len(self.io):
            # mint codes increase along io, so a running max of (mint << SHIFT) + x restarts at every mint by itself
            base = self.mint[self.io].astype(np.int64) << SHIFT
            self.io_tmin = (big - 1) - (np.maximum.accumulate(base + (big - 1 - self.t[self.io])) & (big - 1))
            okio = self.ok[self.io]
            self.io_okmax = (np.maximum.accumulate(np.where(okio, base + self.t[self.io] + 1, base)) & (big - 1)) - 1  # -1 = none
        else:
            self.io_tmin = np.zeros(0, dtype=np.int64)
            self.io_okmax = np.zeros(0, dtype=np.int64)
        self.io_okcum = np.cumsum(self.ok[self.io]).astype(np.int64)

    # ------------------------------------------------------------------------------------------------ construction
    @classmethod
    def from_frame(cls, df: pd.DataFrame, env_filter: bool = True, **kw) -> "SwapTape":
        """
        From swap rows: id, wallet, mint, ts (or t_ms), slot, side, sol_amount, price_sol, token_amount,
        token_balance_before, and optionally ins_ts (default ts). Runs the trailing ok filter (the environment's unless
        env_filter=False: derive's rule).
        """
        d = df.copy()
        d["t"] = d["t_ms"].astype(np.int64) - T0_MS if "t_ms" in d else to_ms(d["ts"])
        has_ins = d["ins_ts"].notna().to_numpy() if "ins_ts" in d else np.zeros(len(d), bool)
        d["ins"] = d["t"].to_numpy()
        if has_ins.any():  # a row without an insert time falls back to its ts, the others keep theirs
            d.loc[has_ins, "ins"] = to_ms(d.loc[has_ins, "ins_ts"])
        d["ins"] = np.maximum(d["ins"].to_numpy(np.int64), d["t"].to_numpy())
        mints, mcode = np.unique(d["mint"].astype(str).to_numpy(), return_inverse=True)
        wallets, wcode = np.unique(d["wallet"].astype(str).to_numpy(), return_inverse=True)
        d["_m"], d["_w"] = mcode.astype(np.int32), wcode.astype(np.int32)
        slot = d["slot"].fillna(0).to_numpy(np.int64) if "slot" in d else np.zeros(len(d), np.int64)
        o = np.lexsort((d["id"].to_numpy(), slot, d["t"].to_numpy(), d["_m"].to_numpy()))
        d = d.iloc[o]
        price = d["price_sol"].to_numpy(np.float64)
        sol = d["sol_amount"].to_numpy(np.float64)
        m = d["_m"].to_numpy(np.int32)
        w = d["_w"].to_numpy(np.int32)
        tokens = d["token_amount"].fillna(0).to_numpy(np.float64)
        _, ok = trailing_ok(m, np.nan_to_num(price, nan=-1.0), np.nan_to_num(sol, nan=0.0), tokens, w, env=env_filter)
        return cls(mints=mints, wallets=wallets, id=d["id"].to_numpy(np.int64), mint=m, t=d["t"].to_numpy(np.int64),
                   wallet=w, side=np.where(d["side"].to_numpy() == "buy", 1, -1).astype(np.int8),
                   sol=sol, price=price, tokens=tokens,
                   bal=d["token_balance_before"].fillna(0).to_numpy(np.float64), ins=d["ins"].to_numpy(np.int64), ok=ok, **kw)

    def thin(self, keep: float, seed: int = 0, always=()) -> "SwapTape":
        """The tape with only a random share `keep` of tracked wallets (stress thin_universe); `always` wallets stay."""
        from brain.sim.params import uniform
        u = uniform(np.arange(len(self.wallets)), "dropout", seed)
        kw = u < keep
        for w in always:
            if w in self.wallet_code:
                kw[self.wallet_code[w]] = True
        r = kw[self.wallet]
        _, ok = trailing_ok(self.mint[r], self.price[r], self.sol[r], self.tokens[r], self.wallet[r], env=True)
        return SwapTape(mints=self.mints, wallets=self.wallets, id=self.id[r], mint=self.mint[r], t=self.t[r], wallet=self.wallet[r],
                        side=self.side[r], sol=self.sol[r], price=self.price[r], tokens=self.tokens[r], bal=self.bal[r], ins=self.ins[r],
                        ok=ok, fee_bps=self.fee_bps, default_depth=self.default_depth, depth_window_ms=self.depth_window_ms,
                        data_end=self.data_end, outage_h=self.outage_h, insert_index=self.insert_index)

    def codes(self, mints) -> np.ndarray:
        """Mint addresses -> codes (-1 when the mint is not on this tape)."""
        return np.array([self.mint_code.get(m, -1) for m in mints], dtype=np.int64)

    def wcodes(self, wallets) -> np.ndarray:
        return np.array([self.wallet_code.get(w, -1) for w in wallets], dtype=np.int64)

    # ------------------------------------------------------------------------------------------------ ok-price lookups
    def last_ok(self, mint, t) -> np.ndarray:
        """Index (into the ok arrays) of the last ok print of `mint` at or before t, -1 if none."""
        mint = np.asarray(mint, dtype=np.int64)
        j = np.searchsorted(self.ok_key, key(mint, t), side="right") - 1
        jc = np.clip(j, 0, max(len(self.ok_key) - 1, 0))
        good = (j >= 0) & (len(self.ok_key) > 0)
        if len(self.ok_key):
            good &= self.ok_mint[jc] == mint
        return np.where(good, j, -1)

    def next_ok(self, mint, t, strict: bool = True) -> np.ndarray:
        """Index of the first ok print of `mint` after t (at or after when strict=False), -1 if none."""
        mint = np.asarray(mint, dtype=np.int64)
        j = np.searchsorted(self.ok_key, key(mint, t), side="right" if strict else "left")
        n = len(self.ok_key)
        jc = np.clip(j, 0, max(n - 1, 0))
        good = (j < n) & (n > 0)
        if n:
            good &= self.ok_mint[jc] == mint
        return np.where(good, j, -1)

    def ok_count(self, mint, t_from, t_to) -> np.ndarray:
        """ok prints of `mint` with t in [t_from, t_to) (ts order, environment use)."""
        mint = np.asarray(mint, dtype=np.int64)
        return np.searchsorted(self.ok_key, key(mint, t_to), "left") - np.searchsorted(self.ok_key, key(mint, t_from), "left")

    # ------------------------------------------------------------------------------------------------ model.ts depth / mid
    def _pairs(self) -> None:
        """model.ts _estimateDepth pair values flow / dln per consecutive ok pair (k, k+1) of a mint, NaN when not usable."""
        n = len(self.okr)
        pv = np.full(n, np.nan)
        if n > 1:
            a, b = np.arange(n - 1), np.arange(1, n)
            same = self.ok_mint[a] == self.ok_mint[b]
            gap_ok = (self.ok_t[b] - self.ok_t[a]) <= PAIR_MAX_GAP_MS
            with np.errstate(all="ignore"):
                dln = np.log(self.ok_mid[b] / self.ok_mid[a])
                flow = np.where(self.ok_side[a] > 0, self.ok_sol[a], -self.ok_sol[a]) + np.where(self.ok_side[b] > 0, self.ok_sol[b], -self.ok_sol[b])
                use = same & gap_ok & np.isfinite(dln) & (np.abs(dln) >= PAIR_MIN_MOVE) & (flow * dln > 0)
                pv[a] = np.where(use, flow / dln, np.nan)
        self.pair_val = pv

    def depth_at(self, idx) -> np.ndarray:
        """model.ts Tape.depthAt for ok rows `idx` (cached): median pair value over the last 10 min, else the last 400 rows, else default."""
        idx = np.asarray(idx, dtype=np.int64)
        need = np.unique(idx[(idx >= 0) & np.isnan(self.depth[np.clip(idx, 0, max(len(self.depth) - 1, 0))])]) if len(idx) else idx
        if len(need):
            frm_all = np.searchsorted(self.ok_key, key(self.ok_mint[need], self.ok_t[need] - self.depth_window_ms), "left")
            frm_all = np.maximum(frm_all, self.ok_first[need])
            pv = self.pair_val
            for i, frm in zip(need.tolist(), frm_all.tolist()):
                d = self._estimate(frm, i)
                if d is None:
                    d = self._estimate(max(self.ok_first[i], i - FALLBACK_LOOKBACK), i)
                self.depth[i] = self.default_depth if d is None else d
        out = np.full(len(idx), float(self.default_depth))  # float: an int default would truncate every depth
        has = idx >= 0
        out[has] = self.depth[idx[has]]
        return out

    def _estimate(self, frm: int, to: int):
        if to - frm < MIN_DEPTH_PAIRS:
            return None
        s = self.pair_val[frm:to]
        s = s[~np.isnan(s)]
        if len(s) < MIN_DEPTH_PAIRS:
            return None
        return min(MAX_DEPTH, max(MIN_DEPTH, float(np.median(s))))

    def mid_at(self, idx) -> tuple[np.ndarray, np.ndarray]:
        """model.ts midAt at ok row idx: the print's fee-free mid with its own impact added; (mid, depth). NaN for idx -1."""
        idx = np.asarray(idx, dtype=np.int64)
        depth = self.depth_at(idx)
        j = np.clip(idx, 0, max(len(self.okr) - 1, 0))
        if not len(self.okr):
            return np.full(len(idx), np.nan), depth
        imp = np.minimum(MAX_IMPACT, self.ok_sol[j] / depth)
        mid = np.where(self.ok_side[j] > 0, self.ok_mid[j] * (1 + imp), self.ok_mid[j] / (1 + imp))
        return np.where(idx >= 0, mid, np.nan), depth

    # ------------------------------------------------------------------------------------------------ hindsight / censoring
    def alive(self, mint, t, lookahead_ms: int) -> tuple[np.ndarray, np.ndarray]:
        """
        (alive, censored): an ok print of `mint` in (t, t + lookahead]. When there is none but the window crosses the data
        end or an ingest-outage hour, darkness is unknowable: counted alive, flagged censored.
        """
        j = self.next_ok(mint, t)
        jc = np.clip(j, 0, max(len(self.ok_t) - 1, 0))
        t = np.asarray(t, dtype=np.int64)
        has = (j >= 0) & (self.ok_t[jc] <= t + lookahead_ms) if len(self.ok_t) else np.zeros(len(t), bool)
        end = t + lookahead_ms
        cens = end > self.data_end
        if len(self.outage_h):
            a = np.searchsorted(self.outage_h, t - 3_600_000, "right")
            b = np.searchsorted(self.outage_h, end, "left")
            cens |= b > a
        cens &= ~has
        return has | cens, cens

    # ------------------------------------------------------------------------------------------------ block-time state
    def first_t(self, mint, t) -> np.ndarray:
        """Earliest ts among swaps of `mint` with ts < t (-1 if none): the first tracked sighting as a live stream had it."""
        mint = np.asarray(mint, dtype=np.int64)
        f = self.mint_first_t[np.clip(mint, 0, max(len(self.mint_first_t) - 1, 0))] if len(self.mint_first_t) else np.full(len(mint), INF_T)
        return np.where((mint >= 0) & (f < np.asarray(t, dtype=np.int64)), f, -1)

    # ------------------------------------------------------------------------------------------------ insert-time features
    def known_counts(self, mint, t_from, t_to) -> np.ndarray:
        """Swaps (any) of `mint` inserted in [t_from, t_to)."""
        mint = np.asarray(mint, dtype=np.int64)
        return np.searchsorted(self.io_key, key(mint, t_to), "left") - np.searchsorted(self.io_key, key(mint, t_from), "left")

    def known_ok_counts(self, mint, t_from, t_to) -> np.ndarray:
        mint = np.asarray(mint, dtype=np.int64)
        a = np.searchsorted(self.io_key, key(mint, t_from), "left")
        b = np.searchsorted(self.io_key, key(mint, t_to), "left")
        c = np.r_[0, self.io_okcum]
        return c[b] - c[a]

    def last_known_ok_t(self, mint, t) -> np.ndarray:
        """ts of the last ok print of `mint` among swaps inserted before t (-1 if none): mins_since_tracked_price."""
        mint = np.asarray(mint, dtype=np.int64)
        j = np.searchsorted(self.io_key, key(mint, t), "left") - 1
        jc = np.clip(j, 0, max(len(self.io_key) - 1, 0))
        if not len(self.io_key):
            return np.full(len(mint), -1)
        good = (j >= 0) & (self.mint[self.io[jc]] == mint)
        return np.where(good, self.io_okmax[jc], -1)

    def first_known_t(self, mint, t) -> np.ndarray:
        """Earliest ts among swaps of `mint` inserted before t (-1 if none): the first tracked sighting known at t."""
        mint = np.asarray(mint, dtype=np.int64)
        j = np.searchsorted(self.io_key, key(mint, t), "left") - 1
        jc = np.clip(j, 0, max(len(self.io_key) - 1, 0))
        if not len(self.io_key):
            return np.full(len(mint), -1)
        good = (j >= 0) & (self.mint[self.io[jc]] == mint)
        return np.where(good, self.io_tmin[jc], -1)

    def flow(self, mint, leader, t, window_ms: int = 300_000, clock: str = "insert") -> dict[str, np.ndarray]:
        """
        Exit flow features over the mint's swaps in [t - window, t), leader excluded: distinct buyers / sellers, net SOL
        (features.yaml oth_buyers_5m, oth_sellers_5m, oth_net_sol_5m) and pts_5m (ok prints, leader included).
        clock "insert": swaps inserted in the window (the INSERT-TIME rule); "block": swaps with ts in the window, as a live
        stream delivers them (the simulator's exit state, on the same clock as its marks).
        """
        mint = np.asarray(mint, dtype=np.int64)
        leader = np.asarray(leader, dtype=np.int64)
        t = np.asarray(t, dtype=np.int64)
        idx, order = (self.t_key, None) if clock == "block" else (self.io_key, self.io)
        a = np.searchsorted(idx, key(mint, t - window_ms), "left")
        b = np.searchsorted(idx, key(mint, t), "left")
        n = b - a
        q = np.repeat(np.arange(len(t)), n)
        rows = np.repeat(a - np.r_[0, np.cumsum(n)[:-1]], n) + np.arange(n.sum()) if n.sum() else np.zeros(0, dtype=np.int64)
        if order is not None:
            rows = order[rows]
        other = self.wallet[rows] != leader[q]
        buy = (self.side[rows] > 0) & other
        sell = (self.side[rows] < 0) & other
        net = np.bincount(q, weights=np.where(buy, self.sol[rows], 0.0) - np.where(sell, self.sol[rows], 0.0), minlength=len(t))
        out = {"oth_net_sol_5m": net}
        for name, m in (("oth_buyers_5m", buy), ("oth_sellers_5m", sell)):
            k = np.unique(q[m].astype(np.int64) * (1 << 32) + self.wallet[rows[m]].astype(np.int64))
            out[name] = np.bincount((k >> 32).astype(np.int64), minlength=len(t)).astype(np.float64)
        pts = self.ok_count(mint, t - window_ms, t) if clock == "block" else self.known_ok_counts(mint, t - window_ms, t)
        out["pts_5m"] = pts.astype(np.float64)
        return out


# ---------------------------------------------------------------------------------------------------------- loading
SWAP_SQL = """
    SELECT s.id, s.wallet, s.mint, s.ts, s.slot, s.side, s.sol_amount, s.price_sol, s.token_amount, s.token_balance_before,
           {ins} AS ins_ts
    FROM ({src}) s
    {join}
"""
RANGE_SQL = "SELECT * FROM wallet_swaps WHERE mint IN (SELECT mint FROM _sim_mints) AND ts >= TIMESTAMPTZ {start} AND ts < TIMESTAMPTZ {end}"
# the last `warm` valid prints of each mint in [warm_from, start): the trailing ok filter's whole history at `start`
WARM_SQL = """
    SELECT * FROM wallet_swaps WHERE mint IN (SELECT mint FROM _sim_mints)
      AND ts >= TIMESTAMPTZ {warm_from} AND ts < TIMESTAMPTZ {start}
      AND price_sol > 0 AND isfinite(price_sol) AND sol_amount >= {min_sol} AND token_amount >= {min_tokens}
    QUALIFY row_number() OVER (PARTITION BY mint ORDER BY ts DESC, slot DESC, id DESC) <= {warm}
"""


def tape_frame(con, mints, start, end, warm: int = 0, warm_from=None) -> pd.DataFrame:
    """
    Every swap of `mints` with ts in [start, end) from the duckdb `wallet_swaps` view (live + archive), with ins_ts from
    ins_steps (an ASOF join on id; ts when it is not built). Filtered by mint first: the view is I/O heavy on the USB drive.
    warm > 0 adds the last `warm` valid prints of each mint in [warm_from, start): the trailing ok flag of a print depends
    only on the mint's previous TRAIL_WINDOW valid prices and their wallets, so warm = TRAIL_WINDOW gives every print from
    `start` on the flag a tape starting at warm_from would give it, at a fraction of the rows.
    """
    con.register("_sim_mints_df", pd.DataFrame({"mint": pd.unique(pd.Series(list(mints), dtype=str))}))
    con.execute("CREATE OR REPLACE TEMP TABLE _sim_mints AS SELECT mint FROM _sim_mints_df")
    con.unregister("_sim_mints_df")
    has_steps = con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name = 'ins_steps'").fetchone()[0] > 0
    if has_steps:
        ins = "CASE WHEN s.id <= (SELECT max(id) FROM ins_steps) THEN to_timestamp(greatest(i.ins_t, epoch(s.ts)::BIGINT)) ELSE s.ts END"
        join = "ASOF LEFT JOIN ins_steps i ON s.id >= i.id"
    else:
        ins, join = "s.ts", ""
    st, en = (pd.Timestamp(x) if pd.Timestamp(x).tzinfo else pd.Timestamp(x, tz="UTC") for x in (start, end))
    src = RANGE_SQL.format(start=sql_str(st.isoformat()), end=sql_str(en.isoformat()))
    if warm > 0:
        wf = pd.Timestamp(warm_from) if pd.Timestamp(warm_from).tzinfo else pd.Timestamp(warm_from, tz="UTC")
        src += " UNION ALL " + WARM_SQL.format(warm_from=sql_str(wf.isoformat()), start=sql_str(st.isoformat()), min_sol=MIN_PRICE_SOL,
                                               min_tokens=MIN_PRICE_TOKENS, warm=int(warm))
    return con.execute(SWAP_SQL.format(ins=ins, join=join, src=src)).df()


def outage_ms(con) -> np.ndarray:
    """Masked ingest-outage hour starts (derived/outage_hours) in ms since T0_MS; empty when not built."""
    try:
        return con.execute("SELECT h FROM outage_hours ORDER BY h").df()["h"].to_numpy(np.int64) * 1000 - T0_MS
    except Exception:  # noqa: BLE001 - no derived outage table (tests, old builds)
        return np.zeros(0, dtype=np.int64)


def load_tape(con, mints, start, end, data_end=None, **kw) -> SwapTape:
    """tape_frame -> SwapTape, with the data end (censoring) and the outage hours of this connection."""
    if data_end is not None:
        kw["data_end"] = int(to_ms([data_end])[0])
    kw.setdefault("outage_h", outage_ms(con))
    return SwapTape.from_frame(tape_frame(con, mints, start, end), **kw)
