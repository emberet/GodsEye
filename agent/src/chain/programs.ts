/**
 * Solana programs and accounts GodsEye recognizes when reading a transaction.
 * Used to label where a swap happened (venue) and as signals for the
 * AI-vs-human classifier (e.g. Jito tips, calling an AMM directly).
 */

export const VENUES: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pumpfun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "meteora",
};

/**
 * Programs recognised only to LABEL where a swap happened. They are not in VENUES on purpose: VENUES is also what the live
 * stream subscribes to, and subscribing to Meteora's bonding-curve launches floods wallet promotion with volume-farm wallets.
 * (To receive them anyway, list the program ids in STREAM_PROGRAMS.)
 */
export const LABEL_ONLY_VENUES: Record<string, string> = {
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "meteora dbc", // Dynamic Bonding Curve (virtual pools before migration)
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "meteora damm v2", // where DBC tokens migrate
  // Ids and names from Jupiter's public program-id-to-label list (checked 2026-10-27). More of the venues a swap can go through.
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "raydium launchlab",
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "phoenix",
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: "openbook",
  MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms: "manifest",
  // Proprietary AMMs: priced by their own oracle logic, so their depth is not readable from an account
  "9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp": "prop amm", // HumidiFi
  SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe: "prop amm", // SolFi
  SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF: "prop amm", // SolFi V2
  TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH: "prop amm", // TesseraV
  goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE: "prop amm", // GoonFi V2
  BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi: "prop amm", // BisonFi
  ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY: "prop amm", // ZeroFi
  obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y: "prop amm", // Obric V2
  ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA: "prop amm", // AlphaQ
  // Other launchpads with their own curves
  HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o: "heaven",
  MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: "moonit",
  boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4: "boop",
  MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F: "memefun",
};

/** Every program that names a venue. */
export const VENUE_LABELS: Record<string, string> = { ...VENUES, ...LABEL_ONLY_VENUES };

/** Venue precedence when a transaction touches several (aggregator first). */
export const VENUE_RANK = [
  "jupiter", "pumpfun", "pumpswap", "raydium", "orca", "meteora", "meteora dbc", "meteora damm v2",
  "raydium launchlab", "heaven", "moonit", "boop", "memefun", "phoenix", "openbook", "manifest", "prop amm",
];

/** Programs that are plumbing, not a venue. */
export const PLUMBING = new Set([
  "11111111111111111111111111111111", // System
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated token accounts
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

/** Jito tip accounts — paying one means the trader is buying block priority (common for bots and snipers). */
export const JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

/** Programs GodsEye's own Jupiter swap transactions may call at the top level (checked before signing). */
export const ALLOWED_SWAP_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);
