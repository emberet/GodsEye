//! The transaction shape the parser reads: the Rust twin of `TxLike` in agent/src/chain/parse.ts.
//! Numbers are f64 on purpose: the TypeScript parser does all its arithmetic in doubles, and matching it exactly
//! (including rounding on balances above 2^53 lamports) is the point of this crate.

#[derive(Debug, Clone, PartialEq)]
pub struct TokenBalance {
    pub account_index: usize,
    pub mint: String,
    pub owner: Option<String>,
    /// Raw amount as a decimal integer string.
    pub amount: String,
    pub decimals: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    /// The transaction failed (`meta.err` is truthy).
    pub err: bool,
    pub fee: f64,
    pub pre_balances: Vec<f64>,
    pub post_balances: Vec<f64>,
    pub pre_token_balances: Vec<TokenBalance>,
    pub post_token_balances: Vec<TokenBalance>,
    /// Program id of every inner instruction, grouped like `innerInstructions[].instructions[]`.
    pub inner_instructions: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tx {
    pub slot: f64,
    pub block_time: Option<f64>,
    pub meta: Option<Meta>,
    pub signatures: Vec<String>,
    pub account_keys: Vec<String>,
    /// Program id of every top-level instruction.
    pub instructions: Vec<String>,
}

impl Meta {
    /// `meta.preBalances[i]`, with JavaScript's `undefined` arithmetic (NaN) past the end.
    #[inline]
    pub fn pre(&self, i: usize) -> f64 {
        self.pre_balances.get(i).copied().unwrap_or(f64::NAN)
    }
    #[inline]
    pub fn post(&self, i: usize) -> f64 {
        self.post_balances.get(i).copied().unwrap_or(f64::NAN)
    }
}
