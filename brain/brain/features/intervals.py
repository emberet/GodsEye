"""
Vectorised point-in-time queries for the offline build (build.py), on integer epoch seconds.

Every windowed feature is "items active at the query time": a swap counts at decision time t = T + L when it is in the
block-time window [T - W, T) and was stored before t (ins_ts < t). Because ins_ts >= ts, that is one interval in T:
active for s < T <= e with s = max(ts, ins_ts - L) and e = ts + W (ledger rows the same way on their availability time).
So a window count over a 2-D condition is a 1-D stabbing count: #{s < T} - #{e < T}, two binary searches per query.

    stab(...)        sum of weights of the intervals of a group active at each query
    islands(...)     merge each group's overlapping intervals (distinct counts: a mint is "in the window" while any of
                     its buys is)
    stab_max(...)    max value over active intervals (a sweep with a heap: dd_from_high)
    first_le(...)    first index >= start with value <= level (stop-loss hits), block-decomposed
    range_min(...)   min over [lo, hi) per query, block-decomposed
"""
from __future__ import annotations

import heapq

import numpy as np

SHIFT = np.int64(1) << np.int64(32)  # group * 2^32 + time: epoch seconds stay below 2^31 until 2038
BLOCK = 64


def _keys(group, time) -> np.ndarray:
    return np.asarray(group, dtype=np.int64) * SHIFT + np.asarray(time, dtype=np.int64)


def stab(group, s, e, q_group, q_t, w=None) -> np.ndarray:
    """
    For each query (q_group, q_t): the sum of w (count when None) over intervals of the same group with s < q_t <= e.
    Empty intervals (s >= e) are ignored.
    """
    group, s, e = (np.asarray(x, dtype=np.int64) for x in (group, s, e))
    w = np.ones(len(s)) if w is None else np.asarray(w, dtype=np.float64)
    keep = s < e
    group, s, e, w = group[keep], s[keep], e[keep], w[keep]
    q = _keys(q_group, q_t)
    base = _keys(q_group, 0)
    out = np.zeros(len(q))
    for t_arr, sign in ((s, 1.0), (e, -1.0)):
        k = _keys(group, t_arr)
        o = np.argsort(k, kind="stable")
        k = k[o]
        cw = np.concatenate([[0.0], np.cumsum(w[o])])
        out += sign * (cw[np.searchsorted(k, q, "left")] - cw[np.searchsorted(k, base, "left")])
    return out


def islands(group, s, e) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Merge overlapping or touching (s, e] intervals within each group: (group, s, e) of the unions."""
    group, s, e = (np.asarray(x, dtype=np.int64) for x in (group, s, e))
    keep = s < e
    group, s, e = group[keep], s[keep], e[keep]
    if not len(s):
        return group, s, e
    o = np.lexsort((s, group))
    g, s, e = group[o], s[o], e[o]
    gi = np.concatenate([[0], np.cumsum(g[1:] != g[:-1])])  # dense group index, ascending
    run = np.maximum.accumulate(e + gi * (SHIFT * 4)) - gi * (SHIFT * 4)  # running max of e within the group
    prev = np.concatenate([[np.iinfo(np.int64).min], run[:-1]])
    new = np.concatenate([[True], g[1:] != g[:-1]]) | (s > prev)
    starts = np.flatnonzero(new)
    return g[starts], s[starts], np.maximum.reduceat(e, starts)


def stab_max(group, s, e, v, q_group, q_t) -> np.ndarray:
    """For each query: max v over intervals of the same group with s < q_t <= e (NaN when none)."""
    group, s, e = (np.asarray(x, dtype=np.int64) for x in (group, s, e))
    v = np.asarray(v, dtype=np.float64)
    keep = s < e
    group, s, e, v = group[keep], s[keep], e[keep], v[keep]
    io = np.lexsort((s, group))
    ig, is_, ie, iv = group[io].tolist(), s[io].tolist(), e[io].tolist(), v[io].tolist()
    qg, qt = np.asarray(q_group, dtype=np.int64), np.asarray(q_t, dtype=np.int64)
    qo = np.lexsort((qt, qg))
    out = np.full(len(qt), np.nan)
    heap: list[tuple[float, int]] = []
    cur = None
    i, n = 0, len(ig)
    for j, g, t in zip(qo.tolist(), qg[qo].tolist(), qt[qo].tolist()):
        if g != cur:
            cur, heap = g, []
            while i < n and ig[i] < g:
                i += 1
        while i < n and ig[i] == g and is_[i] < t:
            heapq.heappush(heap, (-iv[i], ie[i]))
            i += 1
        while heap and heap[0][1] < t:
            heapq.heappop(heap)
        if heap:
            out[j] = -heap[0][0]
    return out


class _Blocks:
    """Block minima of an array plus a sparse table over them (log2(n / BLOCK) levels)."""

    def __init__(self, values: np.ndarray):
        self.v = np.asarray(values, dtype=np.float64)
        n = len(self.v)
        self.nb = -(-n // BLOCK)
        pad = np.full(self.nb * BLOCK, np.inf)
        pad[:n] = self.v
        self.levels = [pad.reshape(self.nb, BLOCK).min(axis=1)]
        k = 1
        while (1 << k) <= self.nb:
            prev = self.levels[-1]
            half = 1 << (k - 1)
            nxt = np.full(self.nb, np.inf)
            nxt[: self.nb - half] = np.minimum(prev[: self.nb - half], prev[half:])
            self.levels.append(nxt)
            k += 1

    def block_min(self, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
        """min over whole blocks [lo, hi) (inf when empty)."""
        out = np.full(len(lo), np.inf)
        ok = hi > lo
        if not ok.any():
            return out
        ln = (hi - lo)[ok]
        k = np.floor(np.log2(ln)).astype(np.int64)
        lv = np.stack(self.levels)
        a = lv[k, lo[ok]]
        b = lv[k, hi[ok] - (1 << k)]
        out[ok] = np.minimum(a, b)
        return out


def range_min(values, lo, hi, blocks: _Blocks | None = None) -> np.ndarray:
    """min(values[lo:hi]) per query (inf when the range is empty)."""
    b = blocks or _Blocks(values)
    v = b.v
    lo, hi = np.asarray(lo, dtype=np.int64), np.asarray(hi, dtype=np.int64)
    out = np.full(len(lo), np.inf)
    blo = -(-lo // BLOCK)  # first whole block
    bhi = hi // BLOCK  # end of whole blocks
    whole = bhi > blo
    out = np.where(whole, b.block_min(np.where(whole, blo, 0), np.where(whole, bhi, 0)), out)
    # the partial blocks at both ends (each shorter than a block)
    left_end = np.minimum(hi, blo * BLOCK)
    right_start = np.maximum(left_end, bhi * BLOCK)
    for off in range(BLOCK):
        i = lo + off
        m = i < left_end
        if m.any():
            out[m] = np.minimum(out[m], v[i[m]])
        j = right_start + off
        m = j < hi
        if m.any():
            out[m] = np.minimum(out[m], v[j[m]])
    return out


def first_le(values, start, limit, level, blocks: _Blocks | None = None) -> np.ndarray:
    """First index j in [start, limit) with values[j] <= level, per query; -1 when none."""
    b = blocks or _Blocks(values)
    v = b.v
    n = len(v)
    start, limit = np.asarray(start, dtype=np.int64), np.minimum(np.asarray(limit, dtype=np.int64), n)
    level = np.asarray(level, dtype=np.float64)
    out = np.full(len(start), -1, dtype=np.int64)
    # 1. the rest of the starting block
    end0 = np.minimum((start // BLOCK + 1) * BLOCK, limit)
    for off in range(BLOCK):
        i = start + off
        m = (out < 0) & (i < end0)
        if not m.any():
            continue
        hit = m.copy()
        hit[m] = v[i[m]] <= level[m]
        out[hit] = i[hit]
    # 2. the first later block whose minimum is low enough (binary lifting over the sparse table), then inside it
    todo = (out < 0) & (end0 < limit)
    if todo.any():
        q = np.flatnonzero(todo)
        pos = start[q] // BLOCK + 1
        lv = level[q]
        for k in range(len(b.levels) - 1, -1, -1):
            step = 1 << k
            can = pos + step <= b.nb
            if not can.any():
                continue
            m = np.zeros(len(q), dtype=bool)
            m[can] = b.levels[k][pos[can]] > lv[can]
            pos = np.where(m, pos + step, pos)
        inb = pos < b.nb
        res = np.full(len(q), -1, dtype=np.int64)
        for off in range(BLOCK):
            i = pos * BLOCK + off
            m = inb & (res < 0) & (i < n)
            if not m.any():
                continue
            hit = m.copy()
            hit[m] = v[i[m]] <= lv[m]
            res[hit] = i[hit]
        res = np.where((res >= 0) & (res < limit[q]), res, -1)
        out[q] = res
    return out
