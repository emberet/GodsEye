"""
The event-driven paper-copy simulator (sim.yaml): a batch of positions advanced in lockstep, one decision event per
position per round, so a whole day of signals is one vectorised loop and the exit policy is called once per round on every
position that needs a decision.

    data = SimData(tape, sig, sells)                     # signals.py / tape.py
    book = data.book(rows, stake_sol, params, chaos)     # entries: land time, buy fill, failures (all at once)
    while (d := book.advance()) is not None:             # next event of every open position; forced exits done inside
        book.act(d.idx, exit_policy(d.state, d))         # fraction of tokens_left to sell (0 = hold)
    out = book.outcomes()                                # per position: net SOL P&L, close time, reason, ...

Per position, events after the entry fill E (all in ms since T0_MS):
  - the leader's sells of the coin, at once (a sell during the copy delay counts at E, as paper.ts applies it after the fill)
  - ok tracked prints, at most every 15 s after the last network decision, for swap_level_s (the whole hold: CONTRACT.md)
  - the minute tick E + 60 s * k; the tick at 24 h is the max hold
State at an event (what paper.ts sees): the stream's last ok print if it is <= 90 s old, else a simulated sell quote: the
last print x obs_ratio(age, venue, tape) of the quote model (known at t only) or, when the coin is dead in hindsight and
the dead-quote ratio is below no_route_below, no route (quote_failed, marked at last x 0.001; 3 failed minute quotes in a
row = written off with the rent lost).
Forced (CONTRACT.md): written off when dead; -60 % hard stop (on the mark, as paper.ts fires it); 24 h max hold. Every sale
lands after a lognormal delay and fills at model.ts sellFill on the print nearest the land time (a later print only within
10 s) scaled by the quote model's hindsight ratio when that print is > 90 s old (sale_value).
One clock (sim.yaml insert_time): marks, price events, leader sells, mins_since_tracked_price and the flow features all
run on block time, "as if live" (a live stream delivers every swap within seconds of its block), never mixed with the
insert-time proxy that backfilled days (selection, test) are stored on.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from brain.sim.model import buyFill
from brain.sim.params import ENTRY_ERR_MEAN, Chaos, SimParams, lognormal, lognormal_median, uniform
from brain.sim.quotes import QuoteModel, tape_group, venue_group
from brain.sim.tape import T0_MS, SwapTape

INF = np.int64(2**62)
MIN = 60_000
REASONS = ("open", "exit", "hard-stop", "max-hold", "dead", "write-off", "data-end", "buy-fail", "no-fill", "dead-entry",
           "too-late", "bad-print", "skip")
R = {name: i for i, name in enumerate(REASONS)}
# exit-state names of features.yaml the engine fills (the trainer's feature code reads them from Decision.state)
EXIT_STATE = ("ret_now", "peak_ret", "drawdown_from_peak", "minutes_held", "leader_sold", "half_sold", "minutes_since_price",
              "position", "mins_since_tracked_price", "quote_failed", "sell_quote_ratio", "sell_quote_ratio_missing", "mom5",
              "leader_sold_frac", "minutes_since_leader_sold", "entry_venue_pumpswap")
FLOW_STATE = ("oth_buyers_5m", "oth_sellers_5m", "oth_net_sol_5m", "pts_5m")
DROPOUT = ("ret_now", "peak_ret", "drawdown_from_peak", "minutes_since_price", "mins_since_tracked_price", "sell_quote_ratio",
           "mom5", "leader_sold_frac", "minutes_since_leader_sold") + FLOW_STATE


class SimData:
    """What every run over one window shares: the tape, the signals, the leader sells and the quote model."""

    def __init__(self, tape: SwapTape, sig: pd.DataFrame, sells: dict, quotes: QuoteModel | None = None):
        self.tape, self.sig, self.sells = tape, sig.reset_index(drop=True), sells
        self.quotes = quotes or QuoteModel.load()
        s = self.sig
        self.mint = tape.codes(s["mint"])
        self.leader = tape.wcodes(s["leader"])
        self.eid = s["episode_id"].to_numpy(np.int64)
        self.t = s["t_ms"].to_numpy(np.int64)
        self.t_dec = s["t_dec"].to_numpy(np.int64) if "t_dec" in s else self.t  # signals.add_gates: the simulated decision time
        self.vg = venue_group(s["venue"])
        self.pumpswap = (self.vg == 0).astype(np.float32)
        self.lpt = s["leader_pos_tokens"].fillna(0).to_numpy(np.float64) if "leader_pos_tokens" in s else np.zeros(len(s))
        self.lprice = s["leader_price_sol"].fillna(0).to_numpy(np.float64) if "leader_price_sol" in s else np.zeros(len(s))
        self.too_late = s["gate_too_late"].to_numpy(bool) if "gate_too_late" in s else np.zeros(len(s), bool)

    def book(self, rows, stake_sol, params: SimParams | None = None, chaos: Chaos = Chaos(), seed: int = 0,
             features: bool = False, shaping: bool = False) -> "Book":
        return Book(self, np.asarray(rows, dtype=np.int64), np.broadcast_to(np.asarray(stake_sol, dtype=np.float64), np.shape(rows)).copy(),
                    params or SimParams.load(), chaos, seed, features, shaping)


@dataclass
class Decision:
    idx: np.ndarray          # positions (into the book) that need an exit decision now
    state: dict              # name -> array (len(idx)): EXIT_STATE (+ FLOW_STATE with features=True) and event context
    book: "Book"


class Book:
    def __init__(self, data: SimData, rows, stake, p: SimParams, chaos: Chaos, seed: int, features: bool, shaping: bool):
        self.d, self.p, self.c, self.seed, self.features, self.shaping = data, p, chaos, seed, features, shaping
        self.tx = p.tx_cost_sol if chaos.tx_cost_sol is None else chaos.tx_cost_sol
        n = len(rows)
        self.n = n
        self.row = rows
        self.eid = data.eid[rows]
        self.mint = data.mint[rows]
        self.leader = data.leader[rows]
        self.vg = data.vg[rows]
        self.stake = stake
        self.reason = np.full(n, R["open"], dtype=np.int8)
        self.closed = np.zeros(n, bool)
        self.entered = np.zeros(n, bool)
        self.E = np.full(n, INF, dtype=np.int64)
        self.close_t = np.full(n, INF, dtype=np.int64)
        self.entry_px = np.full(n, np.nan)
        self.tok0 = np.zeros(n)
        self.tok = np.zeros(n)
        self.proceeds = np.zeros(n)
        self.ntx = np.zeros(n, dtype=np.int32)
        self.fees = np.zeros(n)
        self.fee_open = np.zeros(n)  # the buy's own fee (chaos fee and spikes included): what the account debits at the open
        self.rent_lost = np.zeros(n, bool)
        self.half = np.zeros(n, bool)
        self.peak = np.zeros(n)
        self.qfails = np.zeros(n, dtype=np.int32)
        self.qfailed = np.zeros(n, bool)
        self.last_q = np.full(n, -INF, dtype=np.int64)
        self.cur = np.zeros(n, dtype=np.int64)
        self.last_eval = np.full(n, -INF, dtype=np.int64)
        off = data.sells["off"]
        self.ls_lo, self.ls_hi = off[rows], off[rows + 1]
        self.ls_ptr = self.ls_lo.copy()
        self.ls_tok = np.zeros(n)
        self.first_ls = np.full(n, INF, dtype=np.int64)
        self.censored = np.zeros(n, bool)
        self.retry_t = np.full(n, INF, dtype=np.int64)
        self.retry_all = np.zeros(n, bool)
        self.retry_frac = np.zeros(n)
        self.retry_reason = np.zeros(n, dtype=np.int8)
        self.attempt = np.zeros(n, dtype=np.int32)
        self.n_dec = np.zeros(n, dtype=np.int32)
        self.n_stale90 = np.zeros(n, dtype=np.int32)
        self.n_stale60m = np.zeros(n, dtype=np.int32)
        self.entry_age = np.full(n, np.nan)
        self.rug_t = np.full(n, INF, dtype=np.int64)
        self.rug_left = np.zeros(n)
        self.u_prev = np.zeros(n)
        self._enter()

    # ------------------------------------------------------------------------------------------------ helpers
    def _u(self, stream: str, idx, attempt=0) -> np.ndarray:
        return uniform(self.eid[idx], stream, self.seed, attempt)

    def _delay_ms(self, idx, stream: str, mu: float, sigma: float, attempt=0) -> np.ndarray:
        d = lognormal(self._u(stream, idx, attempt), mu, sigma) * self.c.delay_mult
        if stream == "entry_land" and self.c.tail_p > 0:
            tail = self._u("tail", idx) < self.c.tail_p
            d = d + np.where(tail, self.c.tail_s[0] + (self.c.tail_s[1] - self.c.tail_s[0]) * self._u("tail_s", idx), 0.0)
        return np.round(d * 1000).astype(np.int64)

    def _in_backlog(self, t) -> np.ndarray:
        if not self.c.backlog_hours:
            return np.zeros(len(t), bool)
        h = ((np.asarray(t) + T0_MS) // 3_600_000) * 3600
        return np.isin(h, np.fromiter(self.c.backlog_hours, dtype=np.int64))

    def _tx_at(self, t) -> np.ndarray:
        if not self.c.tx_spike:
            return np.full(len(t), self.tx)
        h = ((np.asarray(t) + T0_MS) // 3_600_000) * 3600
        m = pd.Series(h).map(self.c.tx_spike).fillna(1.0).to_numpy()
        return self.tx * m

    # ------------------------------------------------------------------------------------------------ entry
    def _enter(self) -> None:
        d, p, c, tape = self.d, self.p, self.c, self.d.tape
        idx = np.flatnonzero(self.stake > 0)
        self.reason[self.stake <= 0] = R["skip"]
        self.closed[self.stake <= 0] = True
        late = d.too_late[self.row[idx]] | self._in_backlog(d.t[self.row[idx]])
        self._close_unfilled(idx[late], "too-late", 0)
        idx = idx[~late]
        miss = self.mint[idx] < 0
        self._close_unfilled(idx[miss], "no-fill", 0)
        idx = idx[~miss]
        # the land delay is measured from the leader's block, the decision lateness is drawn on its own: a buy never lands
        # before it was decided (and sent), so it fills on no price older than the decision
        E = np.maximum(d.t[self.row[idx]] + self._delay_ms(idx, "entry_land", p.entry_land_mu, p.entry_land_sigma),
                       d.t_dec[self.row[idx]] + int(p.entry_after_decision_s * 1000))
        bf = p.buy_fail_p if c.buy_fail_p is None else c.buy_fail_p
        fail = self._u("buy_fail", idx) < bf
        self._close_unfilled(idx[fail], "buy-fail", 1, at=E[fail])
        idx, E = idx[~fail], E[~fail]
        m = self.mint[idx]
        li = tape.last_ok(m, E)
        fi = tape.next_ok(m, E)
        fi_ok = (fi >= 0) & (tape.ok_t[np.clip(fi, 0, None)] <= E + int(p.null_entry_window_s * 1000))
        basis = np.where(li >= 0, li, np.where(fi_ok, fi, -1))
        # keep_null_entry: nothing to fill on within 120 s -> dead from entry (pumpswap, or the tape dies within 10 min), else no fill
        none = basis < 0
        later = tape.ok_count(m[none], E[none], E[none] + int(p.null_entry_dead_s * 1000)) if none.any() else np.zeros(0)
        dead_e = np.zeros(len(idx), bool)
        dead_e[none] = (self.vg[idx[none]] == 0) | (later == 0)
        self._close_dead_entry(idx[dead_e], E[dead_e])
        self._close_unfilled(idx[none & ~dead_e], "no-fill", 0)
        keep = ~none
        idx, E, basis = idx[keep], E[keep], basis[keep]
        mid, depth = tape.mid_at(basis)
        bpx = tape.ok_price[basis]
        lp = d.lprice[self.row[idx]]
        bad = (lp > 0) & ((bpx < lp / p.bad_print_x) | (bpx > lp * p.bad_print_x))
        self._close_unfilled(idx[bad], "bad-print", 0)
        idx, E, basis, mid, depth = idx[~bad], E[~bad], basis[~bad], mid[~bad], depth[~bad]
        st = self.stake[idx]
        f = p.fee_bps / 1e4
        price = mid * (1 + f) * (1 + np.minimum(3, st / depth))
        if c.slip_mult != 1.0:
            price = price * (1 + ENTRY_ERR_MEAN * (c.slip_mult - 1))
        self.entered[idx] = True
        self.E[idx] = E
        self.cur[idx] = E
        self.entry_px[idx] = price
        self.tok0[idx] = st / price
        self.tok[idx] = st / price
        self.ntx[idx] = 1
        self.fees[idx] = self.fee_open[idx] = self._tx_at(E)
        self.entry_age[idx] = np.abs(E - tape.ok_t[basis]) / 1000
        if c.rug_rate > 0:
            rug = self._u("rug", idx) < c.rug_rate
            self.rug_t[idx[rug]] = E[rug] + (1 + np.floor(self._u("rug_min", idx[rug]) * 60)).astype(np.int64) * MIN
            self.rug_left[idx[rug]] = 0.05 * self._u("rug_left", idx[rug])
        if self.shaping:
            self.u_prev[idx] = 0.0

    def _close_unfilled(self, idx, reason: str, n_tx: int, at=None) -> None:
        self.closed[idx] = True
        self.reason[idx] = R[reason]
        self.ntx[idx] = n_tx
        t = self.d.t[self.row[idx]] if at is None else at
        self.fees[idx] = self._tx_at(t) * n_tx if len(idx) else 0.0
        self.fee_open[idx] = self.fees[idx]
        self.close_t[idx] = t

    def _close_dead_entry(self, idx, E) -> None:
        """Bought into a dead coin: the stake and the rent are lost (keep_null_entry)."""
        self.closed[idx] = True
        self.entered[idx] = True
        self.reason[idx] = R["dead-entry"]
        self.ntx[idx] = 1
        self.fees[idx] = self.fee_open[idx] = self._tx_at(E) if len(idx) else 0.0
        self.E[idx] = E
        self.close_t[idx] = E
        self.rent_lost[idx] = True
        self.tok0[idx] = 1.0

    # ------------------------------------------------------------------------------------------------ valuation
    def sale_value(self, idx, L, tokens, apply_chaos: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """
        What selling `tokens` of positions idx brings when the sale lands at L (ms): (sol, no_route, basis age s, censored).
        model.ts sellFill on the print nearest L (a later one only within forward_price_s), x the quote model's hindsight
        ratio when that print is older than fresh_s: alive later -> m_alive(age), dead -> f_dark(age) (no route below
        no_route_below). fill_mode next_price: a stale print is replaced by the next ok print within 6 h, else written off.
        """
        p, c, tape, q = self.p, self.c, self.d.tape, self.d.quotes
        m = self.mint[idx]
        L = np.asarray(L, dtype=np.int64)
        li = tape.last_ok(m, L)
        fi = tape.next_ok(m, L)
        fic = np.clip(fi, 0, None)
        fwd = (fi >= 0) & (tape.ok_t[fic] - L <= int(p.forward_price_s * 1000)) if len(tape.ok_t) else np.zeros(len(L), bool)
        lic = np.clip(li, 0, None)
        use_f = fwd & ((li < 0) | ((tape.ok_t[fic] - L) < (L - tape.ok_t[lic])))
        basis = np.where(use_f, fi, li)
        age = np.where(basis >= 0, np.abs(L - tape.ok_t[np.clip(basis, 0, None)]) / 1000, np.inf)
        alive, cens = tape.alive(m, L, int(p.alive_lookahead_s * 1000))
        stale = age > p.fresh_s
        ratio = np.ones(len(idx))
        no_route = basis < 0
        fresh_q = float(q.m_alive(5.0))
        if p.fill_mode == "next_price":
            nx = tape.next_ok(m, L)
            nxc = np.clip(nx, 0, None)
            ok_nx = (nx >= 0) & (tape.ok_t[nxc] <= L + int(p.alive_lookahead_s * 1000))
            basis = np.where(stale, np.where(ok_nx, nx, -1), basis)
            no_route |= stale & ~ok_nx & ~cens
        else:
            a = np.where(np.isfinite(age), age, 1e9)
            ra = q.m_alive(a) / fresh_q
            rd = q.f_dark(a)
            ratio = np.where(stale, np.where(alive, ra, rd / fresh_q), 1.0)
            no_route |= stale & ~alive & (rd < p.no_route_below)
        mid, depth = tape.mid_at(np.where(no_route, -1, basis))
        mid = np.nan_to_num(mid) * ratio
        f = p.fee_bps / 1e4
        val = tokens * mid
        sol = tokens * (mid * (1 - f)) / (1 + np.minimum(3, val / depth))
        slip = p.sell_resid_slip * (c.slip_mult if apply_chaos else 1.0)
        sol = sol * (1 - slip)
        if apply_chaos:
            if c.quote_haircut:
                sol = sol * quote_haircut(self._u("haircut", idx, self.attempt[idx]))
            if c.dead_pool:
                pd_ = np.array([c.dead_pool.get(k, 0.0) for k in ("pumpswap", "pumpfun", "other")])[self.vg[idx]]
                kill = (age > 3600) & (self._u("dead_pool", idx, self.attempt[idx]) < pd_)
                sol = np.where(kill, 0.0, sol)
                no_route |= kill
            if c.rug_rate > 0:
                after = L >= self.rug_t[idx]
                just = after & (L < self.rug_t[idx] + MIN)
                sol = np.where(just, tokens * self.entry_px[idx] * self.rug_left[idx], sol)
                no_route |= after & ~just
        cap = tokens * self.entry_px[idx] * p.bad_print_x
        sol = np.where(no_route, 0.0, np.minimum(sol, cap))
        return sol, no_route, np.where(np.isfinite(age), age, np.nan), cens & ~no_route

    def _mark(self, idx, t, price_event) -> dict:
        """What paper.ts sees at t: the stream price (fresh), a simulated quote (stale), or no route."""
        p, tape, q = self.p, self.d.tape, self.d.quotes
        m = self.mint[idx]
        li = tape.last_ok(m, t)
        has = li >= 0
        lic = np.clip(li, 0, None)
        last = np.where(has, tape.ok_price[lic], self.entry_px[idx])
        lt = np.where(has, tape.ok_t[lic], self.E[idx])
        age = (t - lt) / 1000
        stale = (age > p.fresh_s) & ~price_event
        n10 = tape.ok_count(m, t - 600_000, t)
        obs = q.obs_ratio(age, self.vg[idx], tape_group(n10))
        alive, cens = tape.alive(m, t, int(p.alive_lookahead_s * 1000))
        dead_ratio = q.f_dark(np.maximum(age, 0))
        no_route = stale & ~alive & (dead_ratio < p.no_route_below)
        if self.c.rug_rate > 0:
            no_route |= t >= self.rug_t[idx]
        mark = np.where(no_route, last * p.no_route_mark, np.where(stale, last * obs, last))
        return {"mark": mark, "age": age, "stale": stale, "no_route": no_route, "obs": obs, "censored": cens & stale & ~no_route,
                "last": last, "has": has}

    # ------------------------------------------------------------------------------------------------ the event loop
    def active(self) -> np.ndarray:
        return np.flatnonzero(self.entered & ~self.closed)

    def advance(self) -> Decision | None:
        """Move every open position to its next event; settle retries and forced exits; return those needing a decision."""
        while True:
            a = self.active()
            if not len(a):
                return None
            dec = self._round(a)
            if dec is not None:
                return dec

    def _round(self, a: np.ndarray) -> Decision | None:
        p, d, tape = self.p, self.d, self.d.tape
        sells = d.sells
        cur, E = self.cur[a], self.E[a]
        # next leader sell (a sell before the fill counts at the fill). While a failed sale's retry is pending the position
        # takes no decision, so its leader sells wait and are delivered (in order, at once) once the retry has landed
        has_ls = (self.ls_ptr[a] < self.ls_hi[a]) & (self.retry_t[a] == INF)
        t_sell = np.maximum(sells["t"][np.clip(self.ls_ptr[a], 0, max(len(sells["t"]) - 1, 0))] if len(sells["t"]) else 0, E)
        t_ls = np.where(has_ls, np.maximum(t_sell, cur), INF)
        # next stream price decision (within swap_level_s of the fill), at most every price_event_gap after the last decision
        lvl_end = E + int(p.swap_level_s * 1000)
        frm = np.maximum(cur, self.last_eval[a] + int(p.price_event_gap_s * 1000) - 1)
        nx = tape.next_ok(self.mint[a], frm)
        t_px = np.where(nx >= 0, tape.ok_t[np.clip(nx, 0, None)] if len(tape.ok_t) else INF, INF)
        t_px = np.where((t_px <= lvl_end) & (cur < lvl_end), t_px, INF)
        # minute tick
        k = (cur - E) // MIN + 1
        t_tick = E + k * MIN
        t_retry = self.retry_t[a]
        tau = np.minimum(np.minimum(t_ls, t_px), np.minimum(t_tick, t_retry))
        # the data end: whatever is still open is marked there (censored)
        end = tau >= tape.data_end
        if end.any():
            self._force_close_data_end(a[end])
            keep = ~end
            a, tau, t_ls, t_sell, t_px, t_tick, t_retry = a[keep], tau[keep], t_ls[keep], t_sell[keep], t_px[keep], t_tick[keep], t_retry[keep]
            if not len(a):
                return None
        is_ls, is_px, is_tick, is_retry = t_ls == tau, t_px == tau, t_tick == tau, t_retry == tau
        self.cur[a] = tau
        # leader sells: advance the pointer, accumulate what the leader sold
        if is_ls.any():
            j = a[is_ls]
            ptr = self.ls_ptr[j]
            tk = sells["tokens"][ptr]
            bal = sells["bal"][ptr]
            ls_frac = np.where(bal > 0, np.minimum(1.0, tk / np.where(bal > 0, bal, 1)), 1.0)
            self.ls_tok[j] += tk
            self.first_ls[j] = np.minimum(self.first_ls[j], t_sell[is_ls])  # the sell's own time, even when delivered late
            self.ls_ptr[j] += 1
        else:
            ls_frac = np.zeros(0)
        # pending sale retries land now (no decision)
        if is_retry.any():
            j = a[is_retry]
            self.retry_t[j] = INF
            self._sell(j, tau[is_retry], np.where(self.retry_all[j], 1.0, self.retry_frac[j]), self.retry_all[j], self.retry_reason[j])
        q = ~is_retry & ~self.closed[a] & (self.retry_t[a] == INF)
        if not q.any():
            return None
        a, tau, is_ls_q, is_px, is_tick = a[q], tau[q], is_ls[q], is_px[q], is_tick[q]
        lsf = np.zeros(len(a))
        if len(ls_frac):
            full = np.zeros(len(is_ls), dtype=np.float64)
            full[is_ls] = ls_frac
            lsf = full[q]
        mk = self._mark(a, tau, is_px)
        # quotes: a stale mark is a quote; no route counts toward a dead coin on the minute ticks (paper.ts tick)
        stale = mk["stale"]
        nr = mk["no_route"]
        self.qfailed[a] = nr
        self.qfails[a] = np.where(nr & is_tick, self.qfails[a] + 1, np.where(nr, self.qfails[a], 0))
        self.last_q[a] = np.where(stale & ~nr, tau, self.last_q[a])
        self.censored[a] |= mk["censored"]
        ret = np.minimum(mk["mark"] / self.entry_px[a] - 1, self.p.bad_print_x - 1)
        self.peak[a] = np.where(nr, self.peak[a], np.maximum(self.peak[a], ret))
        self.n_dec[a] += 1
        self.n_stale90[a] += mk["age"] > p.fresh_s
        self.n_stale60m[a] += mk["age"] > 3600
        held_ms = tau - self.E[a]
        # forced: dead coin
        dead = self.qfails[a] >= p.dead_after_fails
        if dead.any():
            self._write_off(a[dead], tau[dead], "dead")
        # forced: hard stop on the mark (what paper.ts sees now); the sale is valued at its land time in _sell
        stop = ~dead & ~nr & (ret <= -p.hard_stop)
        maxh = ~dead & ~stop & ~nr & (held_ms >= int(p.max_hold_s * 1000))
        wo = ~dead & nr & (held_ms >= int(p.max_hold_s * 1000) + 3_600_000)  # WRITE_OFF_AFTER_MS
        if wo.any():
            self._write_off(a[wo], tau[wo], "write-off")
        forced = stop | maxh
        if forced.any():
            j = a[forced]
            rs = np.where(stop[forced], R["hard-stop"], R["max-hold"]).astype(np.int8)
            self._sell(j, tau[forced], np.ones(len(j)), np.ones(len(j), bool), rs)
        need = ~dead & ~wo & ~forced & ~nr & (is_ls_q | is_px | is_tick)
        if not need.any():
            return None
        j = a[need]
        self.last_eval[j] = tau[need]
        st = self._state(j, tau[need], ret[need], mk, need, is_ls_q[need], is_px[need], is_tick[need], lsf[need])
        return Decision(idx=j, state=st, book=self)

    def _state(self, j, tau, ret, mk, need, is_ls, is_px, is_tick, lsf) -> dict:
        p, d, tape, q = self.p, self.d, self.d.tape, self.d.quotes
        peak = self.peak[j]
        held_min = (tau - self.E[j]) / MIN
        age_min = mk["age"][need] / 60
        stale = mk["stale"][need]
        msp = np.where(stale, np.minimum(np.minimum(age_min, 1.5), 60), np.minimum(age_min, 1.5))
        # one clock for the whole state (sim.yaml insert_time): the mark's last ok print, by block time, as a live stream has it
        mstp = np.where(mk["has"][need], np.minimum(mk["age"][need] / 60, 1440), 1440.0)
        # mom5: the same mark 5 minutes earlier (the entry fill before the position existed)
        t5 = tau - 5 * MIN
        before = t5 < self.E[j]
        m5 = self._mark(j, np.maximum(t5, self.E[j]), np.zeros(len(j), bool))
        r5 = np.where(before, 0.0, m5["mark"] / self.entry_px[j] - 1)
        mom5 = np.clip(np.log(np.maximum(1 + ret, 1e-6)) - np.log(np.maximum(1 + r5, 1e-6)), -3, 3)
        lpt = d.lpt[self.row[j]]
        sold_frac = np.where(lpt > 0, np.minimum(self.ls_tok[j] / np.where(lpt > 0, lpt, 1), 1.0), np.where(self.ls_tok[j] > 0, 1.0, 0.0))
        leader_sold = self.first_ls[j] < INF
        st = {
            "ret_now": np.clip(ret, -1, 20),
            "peak_ret": np.clip(peak, -1, 20),
            "drawdown_from_peak": np.clip(1 - (1 + ret) / (1 + np.maximum(peak, -0.999999)), 0, 1),
            "minutes_held": held_min,
            "leader_sold": leader_sold.astype(np.float32),
            "half_sold": self.half[j].astype(np.float32),
            "minutes_since_price": msp,
            "position": self.tok[j] / self.tok0[j],
            "mins_since_tracked_price": mstp,
            "quote_failed": np.zeros(len(j), dtype=np.float32),
            "sell_quote_ratio": np.where(stale, np.clip(mk["obs"][need], 0, 2), 1.0),
            "sell_quote_ratio_missing": (~stale).astype(np.float32),
            "mom5": mom5,
            "leader_sold_frac": sold_frac,
            "minutes_since_leader_sold": np.where(leader_sold, (tau - np.minimum(self.first_ls[j], tau)) / MIN, 0.0),
            "entry_venue_pumpswap": d.pumpswap[self.row[j]],
            # event context (not features)
            "t": tau, "episode_id": self.eid[j], "row": self.row[j], "event_leader_sell": is_ls, "event_price": is_px,
            "event_tick": is_tick, "leader_sell_frac": lsf, "age_s": mk["age"][need], "stake": self.stake[j],
        }
        if self.features:
            st.update(tape.flow(self.mint[j], np.maximum(self.leader[j], 0), tau, clock="block"))
        if self.c.dropout_p > 0:
            names = self.c.dropout_features or DROPOUT
            for i, name in enumerate(names):
                if name in st:
                    u = uniform(self.eid[j] * 64 + i, "dropout", self.seed, self.n_dec[j])
                    st[name] = np.where(u < self.c.dropout_p, np.nan, st[name])
        return st

    def act(self, idx, frac) -> None:
        """Sell `frac` of each position's tokens_left (0 = hold, 1 = all) at the decision time it was asked at."""
        frac = np.clip(np.nan_to_num(np.asarray(frac, dtype=np.float64)), 0, 1)
        sell = frac > 0
        if not sell.any():
            return
        j = np.asarray(idx)[sell]
        f = frac[sell]
        self._sell(j, self.cur[j], f, f >= 1.0, np.full(len(j), R["exit"], dtype=np.int8))

    def _sell(self, j, t, frac, full, reason) -> None:
        """A sale decided at t: it lands after the exit delay; a failure (chaos) is retried; no route sells nothing."""
        p, c = self.p, self.c
        if not len(j):
            return
        self.attempt[j] += 1
        L = t + self._delay_ms(j, "exit_land", p.exit_land_mu, p.exit_land_sigma, self.attempt[j])
        back = self._in_backlog(t)
        L = np.where(back, L + int(c.backlog_lateness_s * 1000), L)
        sf = p.sell_fail_p if c.sell_fail_p is None else c.sell_fail_p
        if sf > 0:
            fail = self._u("sell_fail", j, self.attempt[j]) < sf
            if fail.any():
                f = j[fail]
                mu = lognormal_median(c.sell_retry_p50_s, p.sell_retry_mu, p.sell_retry_sigma) if c.sell_retry_p50_s else p.sell_retry_mu
                rd = np.round(lognormal(self._u("retry", f, self.attempt[f]), mu, p.sell_retry_sigma) * 1000).astype(np.int64)
                self.retry_t[f] = L[fail] + rd
                self.retry_all[f] = full[fail]
                self.retry_frac[f] = frac[fail]
                self.retry_reason[f] = reason[fail]
                self.ntx[f] += 1
                self.fees[f] += self._tx_at(L[fail])
                ok = ~fail
                j, t, frac, full, reason, L = j[ok], t[ok], frac[ok], full[ok], reason[ok], L[ok]
                if not len(j):
                    return
        tokens = np.where(full, self.tok[j], self.tok[j] * frac)
        sol, nr, _, cens = self.sale_value(j, L, tokens)
        self.censored[j] |= cens
        if nr.any():  # no route: nothing sold, it counts toward a dead coin
            self.qfails[j[nr]] += 1
            self.qfailed[j[nr]] = True
        tx = self._tx_at(L)
        go = ~nr & (full | (sol > tx))  # a part worth less than its fee: keep it
        if not go.any():
            return
        j, sol, tokens, L, tx, reason = j[go], sol[go], tokens[go], L[go], tx[go], reason[go]
        self.proceeds[j] += sol
        self.ntx[j] += 1
        self.fees[j] += tx
        self.tok[j] -= tokens
        part = (~full[go]) & (frac[go] > 0)
        self.half[j[part]] = True
        done = self.tok[j] <= self.tok0[j] * 0.01
        k = j[done]
        self.tok[k] = 0
        self.closed[k] = True
        self.close_t[k] = L[done]
        self.reason[k] = reason[done]

    def _write_off(self, j, t, why: str) -> None:
        self.closed[j] = True
        self.close_t[j] = t
        self.reason[j] = R[why]
        self.rent_lost[j] = True
        self.tok[j] = 0

    def _force_close_data_end(self, j) -> None:
        """Still open at the data end: valued at the policy's own mark there, flagged censored."""
        t = np.full(len(j), self.d.tape.data_end, dtype=np.int64)
        mk = self._mark(j, t, np.zeros(len(j), bool))
        v = np.where(mk["no_route"], 0.0, self.tok[j] * mk["mark"] * (1 - self.p.fee_bps / 1e4))
        self.proceeds[j] += v
        self.ntx[j] += 1
        self.fees[j] += self.tx
        self.tok[j] = 0
        self.closed[j] = True
        self.close_t[j] = t
        self.reason[j] = R["data-end"]
        self.censored[j] = True

    # ------------------------------------------------------------------------------------------------ results
    def potential(self, j) -> np.ndarray:
        """u_t (reward.yaml exit_shaping): net P&L if the rest were sold now at its grounded value (median exit delay)."""
        p = self.p
        t = self.cur[j] + int(np.exp(p.exit_land_mu) * 1000)
        v, nr, _, _ = self.sale_value(j, t, self.tok[j], apply_chaos=False)
        sell_tx = np.where(self.tok[j] > 0, self.tx, 0.0)
        return self.proceeds[j] + v - self.stake[j] - self.fees[j] - sell_tx - np.where(nr & (self.tok[j] > 0), p.rent_sol, 0.0)

    def pnl(self, j=None) -> np.ndarray:
        j = np.arange(self.n) if j is None else np.asarray(j)
        out = self.proceeds[j] - np.where(self.entered[j], self.stake[j], 0.0) - self.fees[j] - np.where(self.rent_lost[j], self.p.rent_sol, 0.0)
        return np.where(self.reason[j] == R["dead-entry"], -self.stake[j] - self.fees[j] - self.p.rent_sol, out)

    def outcomes(self) -> pd.DataFrame:
        sig = self.d.sig
        return pd.DataFrame({
            "row": self.row, "episode_id": self.eid, "leader": sig["leader"].to_numpy()[self.row], "mint": sig["mint"].to_numpy()[self.row],
            "day": sig["day"].to_numpy()[self.row], "t_ms": self.d.t[self.row],
            "t_dec": sig["t_dec"].to_numpy(np.int64)[self.row] if "t_dec" in sig else self.d.t[self.row], "stake": self.stake, "entered": self.entered,
            "E": self.E, "close_t": self.close_t, "pnl": self.pnl(), "reason": np.asarray(REASONS)[self.reason],
            "n_tx": self.ntx, "fees": self.fees, "fee_open": self.fee_open, "rent_lost": self.rent_lost, "censored": self.censored, "entry_px": self.entry_px,
            "entry_age_s": self.entry_age, "n_decisions": self.n_dec, "n_stale90": self.n_stale90, "n_stale60m": self.n_stale60m,
            "hold_s": np.where(self.entered & (self.close_t < INF), (self.close_t - self.E) / 1000, np.nan),
            "half_sold": self.half,
        })


def quote_haircut(u: np.ndarray) -> np.ndarray:
    """Per-sale haircut from the fresh-tape quote residual (execution C16): median -0.33 %, p10 -10.6 %, 4.5 % > 90 % below."""
    u = np.asarray(u, dtype=np.float64)
    q = np.array([0.0, 0.045, 0.10, 0.50, 1.0])
    v = np.array([0.02, 0.10, 0.894, 0.9967, 1.02])
    return np.interp(u, q, v)


def run(book: Book, exit_policy) -> Book:
    """Advance a book to the end with `exit_policy(state, decision) -> fraction of tokens_left to sell`."""
    while (d := book.advance()) is not None:
        book.act(d.idx, exit_policy(d.state, d))
    return book
