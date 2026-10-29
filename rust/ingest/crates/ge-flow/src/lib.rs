//! GodsEye Phase 4 offline analysis.
//!
//! * [`backtest`]: replays a leader's recorded swaps the way the copy engine would have taken them
//!   (a Rust port of `agent/src/replay/model.ts` plus an explicit slippage assumption).
//! * [`flow`]: money-flow / funder-graph analysis: shared-funder and lockstep (sybil) clusters,
//!   lead-lag followers and an independent-signal score per wallet.
//! * [`db`]: read-only loading from the agent's SQLite DB and writing the two result tables.
//!
//! Pure offline analysis: nothing here signs, sends or holds a key.

use std::sync::Arc;

pub mod backtest;
pub mod db;
pub mod flow;
pub mod time;

/// One stored swap (a row of `wallet_swaps`). `t` is Unix milliseconds. `wallet` and `mint` are shared
/// (one allocation per distinct address): the live DB has ~14M swaps but only ~25k wallets and far fewer mints.
#[derive(Clone, Debug, PartialEq)]
pub struct Swap {
    pub wallet: Arc<str>,
    pub mint: Arc<str>,
    pub t: i64,
    pub buy: bool,
    pub token_amount: f64,
    pub token_balance_before: f64,
    pub sol_amount: f64,
    pub price: f64,
}

/// Deterministic synthetic market for tests and benches (no external data).
pub mod synth {
    use crate::Swap;

    /// xorshift64* — tiny deterministic PRNG.
    pub struct Rng(pub u64);
    impl Rng {
        pub fn next_f64(&mut self) -> f64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    pub fn swap(
        wallet: &str,
        mint: &str,
        t_ms: i64,
        buy: bool,
        sol: f64,
        price: f64,
        bal_before: f64,
    ) -> Swap {
        Swap {
            wallet: wallet.into(),
            mint: mint.into(),
            t: t_ms,
            buy,
            token_amount: sol / price,
            token_balance_before: bal_before,
            sol_amount: sol,
            price,
        }
    }

    /// `leaders` wallets each round-tripping `trades_per_leader` mints, with background flow on each mint.
    pub fn market(
        leaders: usize,
        trades_per_leader: usize,
        noise_per_mint: usize,
        seed: u64,
    ) -> Vec<Swap> {
        let mut r = Rng(seed | 1);
        let mut out = Vec::new();
        for l in 0..leaders {
            let w = format!("L{l}");
            for k in 0..trades_per_leader {
                let mint = format!("M{l}_{k}");
                let t0 = (k as i64) * 3_600_000;
                let mut price = 1e-6 * (1.0 + r.next_f64());
                let buy_sol = 0.3 + r.next_f64();
                out.push(swap(&w, &mint, t0, true, buy_sol, price, 0.0));
                let tokens = buy_sol / price;
                let mut t = t0;
                for j in 0..noise_per_mint {
                    t += 1000 + (r.next_f64() * 20_000.0) as i64;
                    price *= 1.0 + (r.next_f64() - 0.48) * 0.1;
                    out.push(swap(
                        &format!("N{}", j % 50),
                        &mint,
                        t,
                        r.next_f64() < 0.55,
                        0.05 + r.next_f64(),
                        price,
                        0.0,
                    ));
                }
                out.push(swap(
                    &w,
                    &mint,
                    t + 5000,
                    false,
                    tokens * price,
                    price,
                    tokens,
                ));
            }
        }
        out
    }
}
