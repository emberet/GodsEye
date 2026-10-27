//! Port of agent/src/chain/programs.ts (only what the parser reads) and the mint constants from shared/src/constants.ts.
//! `tests/programs_sync.rs` checks these tables against the TypeScript sources so they can't drift silently.

pub const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const USDT_MINT: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/// VENUES ++ LABEL_ONLY_VENUES (program id, label).
pub const VENUE_LABELS: &[(&str, &str)] = &[
    ("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "jupiter"),
    ("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pumpfun"),
    ("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pumpswap"),
    ("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "raydium"),
    ("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "raydium"),
    ("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "raydium"),
    ("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "orca"),
    ("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "meteora"),
    ("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", "meteora"),
    ("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "meteora dbc"),
    (
        "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
        "meteora damm v2",
    ),
    (
        "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
        "raydium launchlab",
    ),
    ("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", "phoenix"),
    ("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb", "openbook"),
    ("MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms", "manifest"),
    ("9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp", "prop amm"),
    ("SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe", "prop amm"),
    ("SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF", "prop amm"),
    ("TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH", "prop amm"),
    ("goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE", "prop amm"),
    ("BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi", "prop amm"),
    ("ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY", "prop amm"),
    ("obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y", "prop amm"),
    ("ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA", "prop amm"),
    ("HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o", "heaven"),
    ("MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG", "moonit"),
    ("boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4", "boop"),
    ("MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F", "memefun"),
];

/// The programs the TS stream subscribes to by default (Object.keys(VENUES)).
pub const STREAM_DEFAULT_PROGRAMS: &[&str] = &[
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
];

pub const VENUE_RANK: &[&str] = &[
    "jupiter",
    "pumpfun",
    "pumpswap",
    "raydium",
    "orca",
    "meteora",
    "meteora dbc",
    "meteora damm v2",
    "raydium launchlab",
    "heaven",
    "moonit",
    "boop",
    "memefun",
    "phoenix",
    "openbook",
    "manifest",
    "prop amm",
];

pub const PLUMBING: &[&str] = &[
    "11111111111111111111111111111111",
    "ComputeBudget111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
];

pub const JITO_TIP_ACCOUNTS: &[&str] = &[
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

pub fn venue_label(id: &str) -> Option<&'static str> {
    VENUE_LABELS.iter().find(|(k, _)| *k == id).map(|(_, v)| *v)
}
pub fn is_plumbing(id: &str) -> bool {
    PLUMBING.contains(&id)
}
pub fn is_jito_tip(id: &str) -> bool {
    JITO_TIP_ACCOUNTS.contains(&id)
}

/// shared/src/constants.ts NON_MEMECOIN_MINTS.
pub const NON_MEMECOIN_MINTS: &[&str] = &[
    "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
    "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
    "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
    "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS",
    "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7",
    "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",
    "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
    "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux",
    "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
    "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
];

pub fn is_non_memecoin(mint: &str) -> bool {
    NON_MEMECOIN_MINTS.contains(&mint)
}
