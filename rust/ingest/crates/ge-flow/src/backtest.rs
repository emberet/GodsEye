//! Copy-replay backtest kernel: a port of `agent/src/replay/model.ts` (`Tape`, `buyFill`, `sellFill`,
//! `simulateMint`) with one addition, an explicit adverse `slippage_bps` on every one of our fills.
//!
//! Same rules as the copy engine: one position per token, leader buys under `min_leader_buy_sol`
//! skipped, a fixed copy size (`size_sol`, default = the `COPY_MAX_TRADE_SOL` default 0.1), our fill
//! lands `delay_sec` after the leader's swap, a leader sell of X% sells X% of ours (>= 90% sells all),
//! and our own stop-loss / take-profit / max-hold checked on a one-minute grid.
//! Not replayed (as in the TS replay): rug / holder checks, budget, position-count and daily-loss limits.
//! The tape only holds swaps of wallets GodsEye stored, so delay costs here are a lower bound.

use crate::Swap;
use std::cell::RefCell;
use std::collections::HashMap;

/// Price impact cap (size / depth), as in model.ts.
const MAX_IMPACT: f64 = 3.0;
const MIN_DEPTH: f64 = 1.0;
const MAX_DEPTH: f64 = 5000.0;
const PAIR_MAX_GAP_MS: i64 = 60_000;
const PAIR_MIN_MOVE: f64 = 0.001;
const MIN_DEPTH_PAIRS: usize = 3;
const FALLBACK_LOOKBACK: usize = 400;
/// Returns above 1,000x are pricing errors (MAX_PLAUSIBLE_RETURN_PCT in model.ts); such episodes are dropped.
pub const MAX_PLAUSIBLE_RETURN_PCT: f64 = 100_000.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    pub delay_sec: f64,
    pub land_sec: f64,
    pub size_sol: f64,
    pub fee_bps: f64,
    /// Extra adverse slippage on each of our fills, basis points (assumption; COPY_SLIPPAGE_BPS is the
    /// tolerance, realised slippage is usually lower, so the default here is a third of it).
    pub slippage_bps: f64,
    pub tx_cost_sol: f64,
    pub default_depth_sol: f64,
    pub depth_window_sec: f64,
    pub fixed_depth_sol: Option<f64>,
    pub min_leader_buy_sol: f64,
    pub stop_loss_pct: f64,
    pub take_profit_pct: f64,
    pub max_hold_hours: f64,
    pub check_every_sec: f64,
    pub ideal: bool,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            delay_sec: 5.0,
            land_sec: 2.0,
            size_sol: 0.1,
            fee_bps: 100.0,
            slippage_bps: 100.0,
            tx_cost_sol: 0.0005,
            default_depth_sol: 30.0,
            depth_window_sec: 600.0,
            fixed_depth_sol: None,
            min_leader_buy_sol: 0.2,
            stop_loss_pct: 35.0,
            take_profit_pct: 300.0,
            max_hold_hours: 48.0,
            check_every_sec: 60.0,
            ideal: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Obs {
    pub t: i64,
    pub buy: bool,
    pub price: f64,
    pub sol: f64,
}

pub struct Tape {
    pub obs: Vec<Obs>,
    fee: f64,
    default_depth: f64,
    window_ms: i64,
    fixed_depth: Option<f64>,
    cache: RefCell<HashMap<usize, f64>>,
}

pub struct MidAt {
    pub mid: f64,
    pub depth: f64,
}

fn median(xs: &mut [f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = xs.len() >> 1;
    Some(if xs.len() % 2 == 1 {
        xs[m]
    } else {
        (xs[m - 1] + xs[m]) / 2.0
    })
}

impl Tape {
    /// `obs` must be sorted by time.
    pub fn new(obs: Vec<Obs>, p: &Params) -> Self {
        Tape {
            obs,
            fee: p.fee_bps / 1e4,
            default_depth: p.default_depth_sol,
            window_ms: (p.depth_window_sec * 1000.0) as i64,
            fixed_depth: p.fixed_depth_sol,
            cache: RefCell::new(HashMap::new()),
        }
    }
    pub fn mid(&self, o: &Obs) -> f64 {
        if o.buy {
            o.price / (1.0 + self.fee)
        } else {
            o.price / (1.0 - self.fee)
        }
    }
    /// Index of the last observation at or before t (-1 if none).
    pub fn last_at_or_before(&self, t: i64) -> isize {
        self.obs.partition_point(|o| o.t <= t) as isize - 1
    }
    pub fn first_at_or_after(&self, t: i64) -> usize {
        self.obs.partition_point(|o| o.t < t)
    }
    fn estimate_depth(&self, from: usize, to: usize) -> Option<f64> {
        let mut xs = Vec::new();
        for k in from..to {
            let (a, b) = (&self.obs[k], &self.obs[k + 1]);
            if b.t - a.t > PAIR_MAX_GAP_MS {
                continue;
            }
            let dln = (self.mid(b) / self.mid(a)).ln();
            let fa = if a.buy { a.sol } else { -a.sol };
            let fb = if b.buy { b.sol } else { -b.sol };
            let flow = fa + fb;
            if !dln.is_finite() || dln.abs() < PAIR_MIN_MOVE || flow * dln <= 0.0 {
                continue;
            }
            xs.push(flow / dln);
        }
        if xs.len() < MIN_DEPTH_PAIRS {
            return None;
        }
        median(&mut xs).map(|m| m.clamp(MIN_DEPTH, MAX_DEPTH))
    }
    pub fn depth_at(&self, i: usize) -> f64 {
        if let Some(d) = self.fixed_depth {
            return d;
        }
        if let Some(d) = self.cache.borrow().get(&i) {
            return *d;
        }
        let from = self.first_at_or_after(self.obs[i].t - self.window_ms);
        let d = self
            .estimate_depth(from, i)
            .or_else(|| self.estimate_depth(i.saturating_sub(FALLBACK_LOOKBACK), i))
            .unwrap_or(self.default_depth);
        self.cache.borrow_mut().insert(i, d);
        d
    }
    /// Fee-free pool price after the last swap at or before t (that swap's own impact added).
    pub fn mid_at(&self, t: i64) -> Option<MidAt> {
        let i = self.last_at_or_before(t);
        if i < 0 {
            return None;
        }
        let i = i as usize;
        let o = &self.obs[i];
        let depth = self.depth_at(i);
        let impact = (o.sol / depth).min(MAX_IMPACT);
        let m = self.mid(o);
        Some(MidAt {
            mid: if o.buy {
                m * (1.0 + impact)
            } else {
                m / (1.0 + impact)
            },
            depth,
        })
    }
}

/// Our buy: mid x (1+fee) x (1+slippage) x (1 + size/depth). Returns (price, tokens).
pub fn buy_fill(mid: f64, sol_in: f64, depth: f64, fee_bps: f64, slip_bps: f64) -> (f64, f64) {
    let price = mid
        * (1.0 + fee_bps / 1e4)
        * (1.0 + slip_bps / 1e4)
        * (1.0 + (sol_in / depth).min(MAX_IMPACT));
    (price, sol_in / price)
}

/// Our sell: mid x (1-fee) x (1-slippage) / (1 + value/depth). Returns SOL received.
pub fn sell_fill(mid: f64, tokens: f64, depth: f64, fee_bps: f64, slip_bps: f64) -> f64 {
    let value = tokens * mid;
    let price = mid * (1.0 - fee_bps / 1e4) * (1.0 - slip_bps / 1e4)
        / (1.0 + (value / depth).min(MAX_IMPACT));
    tokens * price
}

#[derive(Clone, Debug, PartialEq)]
pub struct Episode {
    pub entry_t: i64,
    pub cost_sol: f64,
    pub proceeds_sol: f64,
    pub pnl_sol: f64,
    pub ret_pct: f64,
    pub closed: bool,
    pub exit_reason: &'static str,
}

struct Pos {
    leader_t: i64,
    fill_t: i64,
    tokens: f64,
    bought: f64,
    held_cost: f64,
    cost: f64,
    proceeds: f64,
    scan_t: i64,
}

/// Replays one leader's swaps (time-ordered, one mint) against that mint's tape.
pub fn simulate_mint(tape: &Tape, leader: &[&Swap], end_t: i64, p: &Params) -> Vec<Episode> {
    let mut out = Vec::new();
    let lag = if p.ideal {
        0
    } else {
        (p.delay_sec * 1000.0) as i64
    };
    let land = if p.ideal {
        0
    } else {
        (p.land_sec * 1000.0) as i64
    };
    let tx = if p.ideal { 0.0 } else { p.tx_cost_sol };
    let (fee, slip) = (p.fee_bps, if p.ideal { 0.0 } else { p.slippage_bps });
    let check = ((p.check_every_sec * 1000.0) as i64).max(1);
    let hold = (p.max_hold_hours * 3_600_000.0) as i64;
    let mut pos: Option<Pos> = None;

    let finish = |x: Pos, closed: bool, reason: &'static str, out: &mut Vec<Episode>| {
        let pnl = x.proceeds - x.cost;
        out.push(Episode {
            entry_t: x.leader_t,
            cost_sol: x.cost,
            proceeds_sol: x.proceeds,
            pnl_sol: pnl,
            ret_pct: if x.cost > 0.0 {
                pnl / x.cost * 100.0
            } else {
                0.0
            },
            closed,
            exit_reason: reason,
        });
    };
    let sell = |x: &mut Pos, tokens: f64, at: i64, leader_price: Option<f64>| -> bool {
        let sol = match (p.ideal, leader_price) {
            (true, Some(lp)) => tokens * lp,
            _ => match tape.mid_at(at) {
                None => return false,
                Some(r) if p.ideal => tokens * r.mid,
                Some(r) => sell_fill(r.mid, tokens, r.depth, fee, slip),
            },
        };
        x.proceeds += sol - tx;
        x.held_cost *= (x.tokens - tokens) / x.tokens;
        x.tokens -= tokens;
        true
    };
    let risk_scan = |x: &mut Pos, to: i64| -> Option<&'static str> {
        let deadline = x.fill_t + hold;
        let limit = to.min(deadline);
        let mut i = tape.first_at_or_after(x.scan_t);
        while i < tape.obs.len() && tape.obs[i].t <= limit {
            let g = x.fill_t + (tape.obs[i].t - x.fill_t + check - 1).div_euclid(check) * check;
            if g > limit {
                break;
            }
            if let Some(r) = tape.mid_at(g) {
                if x.held_cost > 0.0 {
                    let pct = (x.tokens * r.mid - x.held_cost) / x.held_cost * 100.0;
                    let reason = if pct <= -p.stop_loss_pct {
                        Some("stop-loss")
                    } else if pct >= p.take_profit_pct {
                        Some("take-profit")
                    } else {
                        None
                    };
                    if let Some(rs) = reason {
                        let all = x.tokens;
                        if sell(x, all, g + land, None) {
                            return Some(rs);
                        }
                    }
                }
            }
            i = (tape.last_at_or_before(g) + 1) as usize;
        }
        x.scan_t = x.scan_t.max(limit);
        if deadline <= to {
            let all = x.tokens;
            if sell(x, all, deadline + land, None) {
                return Some("max-hold");
            }
        }
        None
    };

    for ev in leader {
        let at = ev.t + lag;
        if let Some(mut x) = pos.take() {
            match risk_scan(&mut x, at) {
                Some(r) => finish(x, true, r, &mut out),
                None => pos = Some(x),
            }
        }
        if ev.buy {
            if pos.is_some() || ev.sol_amount < p.min_leader_buy_sol {
                continue;
            }
            let tokens = if p.ideal {
                p.size_sol / ev.price
            } else {
                match tape.mid_at(at) {
                    None => continue,
                    Some(r) => buy_fill(r.mid, p.size_sol, r.depth, fee, slip).1,
                }
            };
            pos = Some(Pos {
                leader_t: ev.t,
                fill_t: at,
                tokens,
                bought: tokens,
                held_cost: p.size_sol,
                cost: p.size_sol + tx,
                proceeds: 0.0,
                scan_t: at,
            });
        } else if let Some(mut x) = pos.take() {
            let frac = if ev.token_balance_before > 0.0 {
                (ev.token_amount / ev.token_balance_before).min(1.0)
            } else {
                1.0
            };
            let all = frac >= 0.9;
            let amount = if all { x.tokens } else { x.tokens * frac };
            if !sell(&mut x, amount, at, Some(ev.price)) {
                pos = Some(x);
                continue;
            }
            x.scan_t = at;
            if all || x.tokens <= x.bought * 0.01 {
                finish(
                    x,
                    true,
                    if all {
                        "leader sold"
                    } else {
                        "leader sold (rest dust)"
                    },
                    &mut out,
                );
            } else {
                pos = Some(x);
            }
        }
    }
    if let Some(mut x) = pos.take() {
        match risk_scan(&mut x, end_t) {
            Some(r) => finish(x, true, r, &mut out),
            None => {
                if let Some(r) = tape.mid_at(end_t) {
                    let v = if p.ideal {
                        x.tokens * r.mid
                    } else {
                        sell_fill(r.mid, x.tokens, r.depth, fee, slip)
                    };
                    x.proceeds += v - tx;
                }
                finish(x, false, "still open", &mut out);
            }
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LeaderResult {
    pub leader: String,
    pub n_trades: usize,
    pub n_open: usize,
    pub copy_pnl_sol: f64,
    pub copy_return_pct: Option<f64>,
    pub win_rate: Option<f64>,
    /// Largest peak-to-trough fall of cumulative copy P&L (SOL), trades in entry order.
    pub max_drawdown_sol: f64,
    pub ideal_return_pct: Option<f64>,
    pub implausible: usize,
}

/// Swaps grouped by mint, each mint's list sorted by time: the tape for every mint and every leader's swaps.
pub struct Market<'a> {
    pub by_mint: HashMap<&'a str, Vec<&'a Swap>>,
    pub end_t: i64,
}

impl<'a> Market<'a> {
    pub fn new(swaps: &'a [Swap]) -> Self {
        let mut by_mint: HashMap<&str, Vec<&Swap>> = HashMap::new();
        let mut end_t = i64::MIN;
        for s in swaps {
            end_t = end_t.max(s.t);
            by_mint.entry(s.mint.as_str()).or_default().push(s);
        }
        for v in by_mint.values_mut() {
            v.sort_by_key(|s| s.t);
        }
        Market { by_mint, end_t }
    }
    /// The leader's mints (each a tape + the leader's swaps in it).
    pub fn leader_index(&self) -> HashMap<&'a str, Vec<&'a str>> {
        let mut idx: HashMap<&str, Vec<&str>> = HashMap::new();
        for (m, v) in &self.by_mint {
            let mut seen = std::collections::HashSet::new();
            for s in v {
                if seen.insert(s.wallet.as_str()) {
                    idx.entry(s.wallet.as_str()).or_default().push(m);
                }
            }
        }
        idx
    }
}

fn tape_for(swaps: &[&Swap], p: &Params) -> Tape {
    Tape::new(
        swaps
            .iter()
            .map(|s| Obs {
                t: s.t,
                buy: s.buy,
                price: s.price,
                sol: s.sol_amount,
            })
            .collect(),
        p,
    )
}

pub fn episodes(m: &Market, leader: &str, mints: &[&str], p: &Params) -> Vec<Episode> {
    let mut eps = Vec::new();
    for mint in mints {
        let all = &m.by_mint[mint];
        let tape = tape_for(all, p);
        let mine: Vec<&Swap> = all.iter().copied().filter(|s| s.wallet == leader).collect();
        eps.extend(simulate_mint(&tape, &mine, m.end_t, p));
    }
    eps.sort_by_key(|e| e.entry_t);
    eps
}

fn summarize(eps: &[Episode]) -> (f64, Option<f64>, usize, f64, Option<f64>, usize) {
    let (mut pnl, mut cost, mut wins, mut peak, mut cum, mut dd, mut open) =
        (0.0, 0.0, 0usize, 0.0f64, 0.0, 0.0f64, 0);
    for e in eps {
        pnl += e.pnl_sol;
        cost += e.cost_sol;
        if e.pnl_sol > 0.0 {
            wins += 1;
        }
        if !e.closed {
            open += 1;
        }
        cum += e.pnl_sol;
        peak = peak.max(cum);
        dd = dd.max(peak - cum);
    }
    let ret = if cost > 0.0 {
        Some(pnl / cost * 100.0)
    } else {
        None
    };
    let wr = if eps.is_empty() {
        None
    } else {
        Some(wins as f64 / eps.len() as f64)
    };
    (pnl, ret, open, dd, wr, eps.len())
}

pub fn backtest_leader(m: &Market, leader: &str, mints: &[&str], p: &Params) -> LeaderResult {
    let keep = |v: Vec<Episode>| -> (Vec<Episode>, usize) {
        let n = v.len();
        let k: Vec<Episode> = v
            .into_iter()
            .filter(|e| e.ret_pct.abs() <= MAX_PLAUSIBLE_RETURN_PCT)
            .collect();
        let d = n - k.len();
        (k, d)
    };
    let (real, implausible) = keep(episodes(m, leader, mints, p));
    let ideal = keep(episodes(
        m,
        leader,
        mints,
        &Params {
            ideal: true,
            ..p.clone()
        },
    ))
    .0;
    let (pnl, ret, open, dd, wr, n) = summarize(&real);
    LeaderResult {
        leader: leader.to_string(),
        n_trades: n,
        n_open: open,
        copy_pnl_sol: pnl,
        copy_return_pct: ret,
        win_rate: wr,
        max_drawdown_sol: dd,
        ideal_return_pct: summarize(&ideal).1,
        implausible,
    }
}

/// Backtests many leaders in parallel (std threads; no shared mutable state).
pub fn backtest_all(
    m: &Market,
    leaders: &[String],
    p: &Params,
    threads: usize,
) -> Vec<LeaderResult> {
    let idx = m.leader_index();
    let empty: Vec<&str> = Vec::new();
    let threads = threads.max(1);
    let chunk = leaders.len().div_ceil(threads).max(1);
    let mut out: Vec<LeaderResult> = std::thread::scope(|sc| {
        let hs: Vec<_> = leaders
            .chunks(chunk)
            .map(|ls| {
                let idx = &idx;
                let empty = &empty;
                sc.spawn(move || {
                    ls.iter()
                        .map(|l| backtest_leader(m, l, idx.get(l.as_str()).unwrap_or(empty), p))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        hs.into_iter()
            .flat_map(|h| h.join().expect("backtest worker panicked"))
            .collect()
    });
    out.sort_by(|a, b| a.leader.cmp(&b.leader));
    out
}
