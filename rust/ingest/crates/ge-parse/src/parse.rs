//! Port of agent/src/chain/parse.ts: balance-change based swap detection.
//! Every branch, constant and floating-point operation follows the TypeScript in the same order, so results are
//! bit-identical (the golden fixture tests check this against Node's output).

use crate::jsnum::{iso_from_ms, js_number, js_number_from_str, js_round, js_string, pow10};
use crate::programs::{
    is_jito_tip, is_non_memecoin, is_plumbing, venue_label, SOL_MINT, USDC_MINT, USDT_MINT,
    VENUE_RANK,
};
use crate::tx::{TokenBalance, Tx};

pub const TOKEN_ACCOUNT_RENT_LAMPORTS: f64 = 2_039_280.0;
const DUST_TOKENS: f64 = 1e-9;
const STABLECOINS: [(&str, &str); 2] = [(USDC_MINT, "USDC"), (USDT_MINT, "USDT")];
const MIN_SOL: f64 = 0.0001;
const SOL_NOISE: f64 = 0.0005;
const USD_NOISE: f64 = 0.01;
const MIN_ROUTED_LAMPORTS: f64 = 1_000_000.0;
const ROUTE_MATCH: f64 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}
impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }
}

/// `ParsedSwap` from parse.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSwap {
    pub wallet: String,
    pub signature: String,
    pub slot: f64,
    pub ts: String,
    pub venue: Option<String>,
    pub jito_tip: bool,
    pub fee_lamports: f64,
    pub mint: String,
    pub side: Side,
    pub token_amount: f64,
    pub token_balance_before: f64,
    pub sol_amount: f64,
    pub price_sol: f64,
    pub quote: String,
    pub quote_amount: f64,
    pub sol_usd: Option<f64>,
    pub usd_amount: Option<f64>,
}

impl ParsedSwap {
    /// Exactly what `JSON.stringify(swap)` prints in Node (same key order, same number formatting).
    pub fn to_js_json(&self) -> String {
        let opt = |v: Option<f64>| v.map(js_number).unwrap_or_else(|| "null".into());
        let venue = self
            .venue
            .as_deref()
            .map(js_string)
            .unwrap_or_else(|| "null".into());
        format!(
            "{{\"wallet\":{},\"signature\":{},\"slot\":{},\"ts\":{},\"venue\":{},\"jitoTip\":{},\"feeLamports\":{},\"mint\":{},\"side\":\"{}\",\"tokenAmount\":{},\"tokenBalanceBefore\":{},\"solAmount\":{},\"priceSol\":{},\"quote\":{},\"quoteAmount\":{},\"solUsd\":{},\"usdAmount\":{}}}",
            js_string(&self.wallet),
            js_string(&self.signature),
            js_number(self.slot),
            js_string(&self.ts),
            venue,
            self.jito_tip,
            js_number(self.fee_lamports),
            js_string(&self.mint),
            self.side.as_str(),
            js_number(self.token_amount),
            js_number(self.token_balance_before),
            js_number(self.sol_amount),
            js_number(self.price_sol),
            js_string(&self.quote),
            js_number(self.quote_amount),
            opt(self.sol_usd),
            opt(self.usd_amount),
        )
    }
}

/// `JSON.stringify(swaps)` for a list.
pub fn swaps_to_js_json(swaps: &[ParsedSwap]) -> String {
    let mut s = String::from("[");
    for (i, w) in swaps.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&w.to_js_json());
    }
    s.push(']');
    s
}

/// Options of `parseSwaps`. `sol_usd_at(ts_ms)` gives SOL's USD price at a moment; without it dollar-priced swaps are skipped.
#[derive(Default)]
pub struct ParseOptions<'a> {
    pub sol_usd_at: Option<&'a dyn Fn(f64) -> Option<f64>>,
}

#[inline]
fn amount_of(b: &TokenBalance) -> f64 {
    js_number_from_str(&b.amount) / pow10(b.decimals)
}

/// JavaScript truthiness of `number | null`.
#[inline]
fn truthy(v: Option<f64>) -> Option<f64> {
    v.filter(|x| *x != 0.0 && !x.is_nan())
}

/// `detectVenue`.
pub fn detect_venue(tx: &Tx) -> Option<String> {
    let pick = |ids: &mut dyn Iterator<Item = &String>| -> Option<&'static str> {
        let labels: Vec<&'static str> = ids.filter_map(|id| venue_label(id)).collect();
        VENUE_RANK.iter().find(|v| labels.contains(v)).copied()
    };
    if let Some(d) = pick(&mut tx.instructions.iter()) {
        return Some(d.to_string());
    }
    let routed = pick(&mut tx.meta.as_ref()?.inner_instructions.iter().flatten())?;
    let unknown_top = tx
        .instructions
        .iter()
        .any(|id| !is_plumbing(id) && venue_label(id).is_none());
    Some(if unknown_top {
        format!("{routed} (via bot)")
    } else {
        routed.to_string()
    })
}

/// `routedSolLamports`.
pub fn routed_sol_lamports(tx: &Tx, wallet: &str) -> Option<f64> {
    let meta = tx.meta.as_ref()?;
    let wallet_accounts: Vec<usize> = meta
        .pre_token_balances
        .iter()
        .chain(meta.post_token_balances.iter())
        .filter(|b| b.owner.as_deref() == Some(wallet))
        .map(|b| b.account_index)
        .collect();
    let mut out = 0.0f64;
    let mut into = 0.0f64;
    for (i, k) in tx.account_keys.iter().enumerate() {
        if k == wallet || wallet_accounts.contains(&i) || is_jito_tip(k) {
            continue;
        }
        let d = meta.post(i) - meta.pre(i) + if i == 0 { meta.fee } else { 0.0 };
        if d <= -MIN_ROUTED_LAMPORTS {
            out = js_max(out, -d);
        }
        if d >= MIN_ROUTED_LAMPORTS {
            into = js_max(into, d);
        }
    }
    if out == 0.0 || into == 0.0 || js_min(out, into) / js_max(out, into) < ROUTE_MATCH {
        return None;
    }
    Some(out)
}

#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

struct Delta {
    mint: String,
    before: f64,
    after: f64,
}

/// `parseSwaps`: the swaps `wallet` made in this transaction.
pub fn parse_swaps(tx: &Tx, wallet: &str, opts: &ParseOptions) -> Vec<ParsedSwap> {
    let meta = match &tx.meta {
        Some(m) if !m.err => m,
        _ => return vec![],
    };
    let keys = &tx.account_keys;
    let idx = match keys.iter().position(|k| k == wallet) {
        Some(i) => i,
        None => return vec![],
    };

    let mut lamports = meta.post(idx) - meta.pre(idx) + if idx == 0 { meta.fee } else { 0.0 };

    let mut tip_lamports = 0.0f64;
    for (i, k) in keys.iter().enumerate() {
        if is_jito_tip(k) {
            tip_lamports += js_max(0.0, meta.post(i) - meta.pre(i));
        }
    }
    if idx == 0 {
        lamports += tip_lamports;
    }

    let pre: Vec<&TokenBalance> = meta
        .pre_token_balances
        .iter()
        .filter(|b| b.owner.as_deref() == Some(wallet))
        .collect();
    let post: Vec<&TokenBalance> = meta
        .post_token_balances
        .iter()
        .filter(|b| b.owner.as_deref() == Some(wallet))
        .collect();
    // A Map keyed by mint, kept in insertion order like JavaScript's.
    let mut deltas: Vec<Delta> = Vec::new();
    fn slot<'d>(deltas: &'d mut Vec<Delta>, mint: &str) -> &'d mut Delta {
        let pos = match deltas.iter().position(|d| d.mint == mint) {
            Some(p) => p,
            None => {
                deltas.push(Delta {
                    mint: mint.to_string(),
                    before: 0.0,
                    after: 0.0,
                });
                deltas.len() - 1
            }
        };
        &mut deltas[pos]
    }
    for b in &pre {
        slot(&mut deltas, &b.mint).before += amount_of(b);
    }
    for b in &post {
        slot(&mut deltas, &b.mint).after += amount_of(b);
    }
    let rent_of = |i: usize, balances: &[f64]| -> f64 {
        let v = balances.get(i).copied().unwrap_or(0.0);
        if v > 0.0 {
            v
        } else {
            TOKEN_ACCOUNT_RENT_LAMPORTS
        }
    };
    for b in &post {
        if !pre.iter().any(|p| p.account_index == b.account_index) && b.mint != SOL_MINT {
            lamports += rent_of(b.account_index, &meta.post_balances);
        }
    }
    for b in &pre {
        if !post.iter().any(|p| p.account_index == b.account_index) && b.mint != SOL_MINT {
            lamports -= rent_of(b.account_index, &meta.pre_balances);
        }
    }

    if let Some(p) = deltas.iter().position(|d| d.mint == SOL_MINT) {
        let w = deltas.remove(p);
        lamports += js_round((w.after - w.before) * 1e9);
    }

    let mut usd = 0.0f64;
    let mut stables: Vec<&'static str> = Vec::new();
    for (mint, label) in STABLECOINS {
        let Some(p) = deltas.iter().position(|d| d.mint == mint) else {
            continue;
        };
        let d = deltas.remove(p);
        let change = d.after - d.before;
        if change.abs() >= USD_NOISE {
            usd += change;
            if !stables.contains(&label) {
                stables.push(label);
            }
        }
    }

    let moved: Vec<&Delta> = deltas
        .iter()
        .filter(|d| (d.after - d.before).abs() > DUST_TOKENS)
        .collect();
    if moved.iter().any(|d| is_non_memecoin(&d.mint)) {
        return vec![];
    }
    let ts_ms = match tx.block_time {
        Some(bt) => bt * 1000.0,
        None => now_ms(),
    };
    let signature = tx.signatures.first().cloned().unwrap_or_default();
    let venue = detect_venue(tx);
    let jito_tip = tip_lamports > 0.0;
    let ts = iso_from_ms(ts_ms);
    let price_now = opts.sol_usd_at.and_then(|f| f(ts_ms));
    let make = |mint: &str,
                side: Side,
                token_amount: f64,
                before: f64,
                sol_amount: f64,
                price_sol: f64,
                quote: String,
                quote_amount: f64,
                sol_usd: Option<f64>,
                usd_amount: Option<f64>| ParsedSwap {
        wallet: wallet.to_string(),
        signature: signature.clone(),
        slot: tx.slot,
        ts: ts.clone(),
        venue: venue.clone(),
        jito_tip,
        fee_lamports: meta.fee,
        mint: mint.to_string(),
        side,
        token_amount,
        token_balance_before: before,
        sol_amount,
        price_sol,
        quote,
        quote_amount,
        sol_usd,
        usd_amount,
    };

    // Memecoin <-> memecoin, settled through SOL.
    if moved.len() == 2 && stables.is_empty() && (lamports / 1e9).abs() < SOL_NOISE {
        let (a, b) = (moved[0], moved[1]);
        let (ca, cb) = (a.after - a.before, b.after - b.before);
        if js_sign(ca) == js_sign(cb) {
            return vec![];
        }
        let Some(routed) = routed_sol_lamports(tx, wallet) else {
            return vec![];
        };
        if routed == 0.0 || routed.is_nan() {
            return vec![];
        }
        let sol = routed / 1e9;
        let usd_value = truthy(price_now).map(|p| sol * p);
        let mut legs = vec![(a, ca), (b, cb)];
        // Array.prototype.sort is stable; NaN comparisons keep the order.
        if (legs[1].1 - legs[0].1) < 0.0 {
            legs.swap(0, 1);
        }
        return legs
            .into_iter()
            .map(|(d, change)| {
                let side = if change < 0.0 { Side::Sell } else { Side::Buy };
                make(
                    &d.mint,
                    side,
                    change.abs(),
                    d.before,
                    sol,
                    sol / change.abs(),
                    "SOL (routed)".into(),
                    sol,
                    price_now,
                    usd_value,
                )
            })
            .collect();
    }

    if moved.len() != 1 {
        return vec![];
    }
    let d = moved[0];
    let token_delta = d.after - d.before;
    let mut sol = lamports / 1e9;
    let uses_sol = sol.abs() >= SOL_NOISE;
    if !uses_sol && !stables.is_empty() {
        sol = 0.0;
    }
    let sol_usd = price_now;
    let mut value = sol;
    if !stables.is_empty() {
        let Some(p) = truthy(sol_usd) else {
            return vec![];
        };
        value += usd / p;
    }
    let side = if token_delta > 0.0 && value < 0.0 {
        Side::Buy
    } else if token_delta < 0.0 && value > 0.0 {
        Side::Sell
    } else {
        return vec![];
    };
    let sol_amount = value.abs();
    let token_amount = token_delta.abs();
    if sol_amount < MIN_SOL {
        return vec![];
    }
    let mut labels: Vec<&str> = Vec::new();
    if uses_sol || stables.is_empty() {
        labels.push("SOL");
    }
    labels.extend(stables.iter().copied());
    let quote = labels.join("+");
    let quote_amount = if labels.len() == 1 && !stables.is_empty() {
        usd.abs()
    } else {
        sol_amount
    };
    let usd_amount = if !stables.is_empty() && !uses_sol {
        Some(usd.abs())
    } else {
        truthy(sol_usd).map(|p| sol_amount * p)
    };
    vec![make(
        &d.mint,
        side,
        token_amount,
        d.before,
        sol_amount,
        sol_amount / token_amount,
        quote,
        quote_amount,
        sol_usd,
        usd_amount,
    )]
}

/// `parseSwap`: the first swap, if any.
pub fn parse_swap(tx: &Tx, wallet: &str, opts: &ParseOptions) -> Option<ParsedSwap> {
    parse_swaps(tx, wallet, opts).into_iter().next()
}

#[inline]
fn js_sign(x: f64) -> f64 {
    if x.is_nan() {
        f64::NAN
    } else if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
