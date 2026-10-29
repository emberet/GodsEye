//! Money-flow / funder-graph analysis.
//!
//! Inputs: every wallet's FIRST buy of each mint (from `wallet_swaps`) and each wallet's first funder
//! (`wallets.funder`, if known). Three signals:
//!
//! * **Lead-lag (followers).** For an ordered pair (a, b): `follows(a->b)` = mints where b's first buy came
//!   `min_lag_sec < lag <= follow_window_sec` after a's. b is a *follower* of a when `follows(a->b) >=
//!   min_events`, that is at least `follow_share` of b's mints, and clearly more than `follows(b->a)`
//!   (so two wallets trading the same hot coins at random don't both qualify).
//!   `lead_lag_score(b)` = the largest such share over all a (0..1) whether or not it crosses the bar.
//! * **Lockstep (sybil / insider).** `sync(a,b)` = mints both first-bought within `sync_sec` of each other.
//!   An edge when `sync >= min_events` and `sync / min(mints_a, mints_b) >= sync_share`.
//! * **Shared funder.** Wallets with the same `funder` are joined, unless that funder funded more than
//!   `max_funder_group` wallets (likely an exchange hot wallet, which says nothing about common control).
//!
//! Lockstep and shared-funder edges are merged with union-find; a component of >= 2 wallets is a cluster.
//! Roles: `sybil` (in a cluster), else `follower`, else `leader` (someone follows it), else `independent`.
//! `independent_score` = (1 - lead_lag_score) x (1 - sync_share_max) x (0.5 if it shares a funder) in 0..1.

use crate::Swap;
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Debug, PartialEq)]
pub struct FlowParams {
    pub follow_window_sec: f64,
    pub min_lag_sec: f64,
    pub sync_sec: f64,
    pub min_events: u32,
    pub follow_share: f64,
    pub sync_share: f64,
    pub max_funder_group: usize,
}

impl Default for FlowParams {
    fn default() -> Self {
        FlowParams {
            follow_window_sec: 120.0,
            min_lag_sec: 2.0,
            sync_sec: 2.0,
            min_events: 3,
            follow_share: 0.3,
            sync_share: 0.3,
            max_funder_group: 50,
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct WalletFlow {
    pub wallet: String,
    pub cluster_id: Option<String>,
    pub role: &'static str,
    pub funder: Option<String>,
    /// Wallet this one follows most (if a follower).
    pub follows: Option<String>,
    pub lead_lag_score: f64,
    pub sync_score: f64,
    pub independent_score: f64,
    pub n_mints: usize,
}

struct Dsu(Vec<usize>);
impl Dsu {
    fn find(&mut self, x: usize) -> usize {
        let mut r = x;
        while self.0[r] != r {
            r = self.0[r];
        }
        let mut c = x;
        while self.0[c] != r {
            let n = self.0[c];
            self.0[c] = r;
            c = n;
        }
        r
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.0[ra.max(rb)] = ra.min(rb);
        }
    }
}

pub fn analyse(
    swaps: &[Swap],
    funders: &HashMap<String, String>,
    p: &FlowParams,
) -> Vec<WalletFlow> {
    // wallet ids, sorted for deterministic output
    let mut names: Vec<&str> = swaps.iter().filter(|s| s.buy).map(|s| &*s.wallet).collect();
    names.sort_unstable();
    names.dedup();
    let id: HashMap<&str, usize> = names.iter().enumerate().map(|(i, w)| (*w, i)).collect();
    let n = names.len();
    // first buy per (mint, wallet)
    let mut first: HashMap<(&str, usize), i64> = HashMap::new();
    for s in swaps.iter().filter(|s| s.buy) {
        let e = first.entry((&*s.mint, id[&*s.wallet])).or_insert(s.t);
        *e = (*e).min(s.t);
    }
    let mut by_mint: HashMap<&str, Vec<(i64, usize)>> = HashMap::new();
    let mut n_mints = vec![0usize; n];
    for ((m, w), t) in first {
        by_mint.entry(m).or_default().push((t, w));
        n_mints[w] += 1;
    }
    let win = (p.follow_window_sec * 1000.0) as i64;
    let min_lag = (p.min_lag_sec * 1000.0) as i64;
    let sync = (p.sync_sec * 1000.0) as i64;
    let mut follows: HashMap<(usize, usize), u32> = HashMap::new();
    let mut syncs: HashMap<(usize, usize), u32> = HashMap::new();
    let horizon = win.max(sync);
    for v in by_mint.values_mut() {
        v.sort_unstable();
        for i in 0..v.len() {
            let (ta, a) = v[i];
            for &(tb, b) in &v[i + 1..] {
                let lag = tb - ta;
                if lag > horizon {
                    break;
                }
                if lag <= sync {
                    *syncs.entry((a.min(b), a.max(b))).or_default() += 1;
                }
                if lag > min_lag && lag <= win {
                    *follows.entry((a, b)).or_default() += 1;
                }
            }
        }
    }
    let mut lead = vec![(0.0f64, None::<usize>, false); n]; // (score, leader, is_follower)
    let mut is_leader = vec![false; n];
    for (&(a, b), &c) in &follows {
        let share = c as f64 / n_mints[b].max(1) as f64;
        let back = follows.get(&(b, a)).copied().unwrap_or(0);
        let qualifies = c >= p.min_events && share >= p.follow_share && c > 2 * back;
        let cur = &mut lead[b];
        if qualifies && (!cur.2 || share > cur.0) {
            *cur = (share, Some(a), true);
            is_leader[a] = true;
        } else if !cur.2 && share > cur.0 {
            cur.0 = share;
        }
    }
    let mut dsu = Dsu((0..n).collect());
    let mut sync_max = vec![0.0f64; n];
    for (&(a, b), &c) in &syncs {
        let share = c as f64 / n_mints[a].min(n_mints[b]).max(1) as f64;
        if c >= p.min_events && share >= p.sync_share {
            dsu.union(a, b);
        }
        // only repeated co-buys count toward the score (one shared launch is not lockstep)
        if c >= p.min_events {
            sync_max[a] = sync_max[a].max(share.min(1.0));
            sync_max[b] = sync_max[b].max(share.min(1.0));
        }
    }
    let mut groups: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, w) in names.iter().enumerate() {
        if let Some(f) = funders.get(*w) {
            if !f.is_empty() {
                groups.entry(f.as_str()).or_default().push(i);
            }
        }
    }
    let mut shares_funder = vec![false; n];
    for g in groups.values() {
        if g.len() >= 2 && g.len() <= p.max_funder_group {
            for &i in g {
                shares_funder[i] = true;
                dsu.union(g[0], i);
            }
        }
    }
    let mut size: HashMap<usize, usize> = HashMap::new();
    for i in 0..n {
        *size.entry(dsu.find(i)).or_default() += 1;
    }
    (0..n)
        .map(|i| {
            let root = dsu.find(i);
            let clustered = size[&root] >= 2;
            let (ll, leader, follower) = lead[i];
            let role = if clustered {
                "sybil"
            } else if follower {
                "follower"
            } else if is_leader[i] {
                "leader"
            } else {
                "independent"
            };
            let fpen = if shares_funder[i] { 0.5 } else { 1.0 };
            let ind = ((1.0 - ll) * (1.0 - sync_max[i]) * fpen).clamp(0.0, 1.0);
            WalletFlow {
                wallet: names[i].to_string(),
                cluster_id: clustered.then(|| names[root].to_string()),
                role,
                funder: funders.get(names[i]).cloned(),
                follows: leader.map(|a| names[a].to_string()),
                lead_lag_score: ll,
                sync_score: sync_max[i],
                independent_score: ind,
                n_mints: n_mints[i],
            }
        })
        .collect()
}
