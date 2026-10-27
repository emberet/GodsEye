# Pool decoder verification (27 Oct 2026)

The byte offsets in `agent/src/pools/state.ts` came from the programs' IDLs (see `pool_types_and_state.md`, where they were computed and could not be checked). Each decoder was then run against live accounts. This records what was compared and what came out, so the claim "checked against live accounts" has something behind it.

Method, all read-only (public RPC `getMultipleAccounts`, Jupiter quote and GeckoTerminal GETs):
1. **Jupiter hop check.** Quote 0.02–0.05 SOL → token; take the first route hop that spends SOL; read that hop's pool (`ammKey`); predict the hop's output from the decoded reserves with the constant-product formula (`out = base × in / (quote + in)`, no fee); compare with the hop's actual output in the route plan. A correct decode gives a ratio just under 1 (the pool's fee: 0.25% to 2%). A wrong offset or scale gives a ratio far from 1.
2. **GeckoTerminal price check.** For pools listed under a DEX on GeckoTerminal, compare the decoded price (SOL per token) with its `base_token_price_native_currency`.

| Venue | Check | Pools | Result |
|---|---|---|---|
| pump.fun bonding curve | Jupiter hop | 7 | ratio 0.9877 on all (the 1.23% fee) |
| pump.fun bonding curve | GeckoTerminal price | 13 SOL-quoted, 1 quoted in something else | price ratio 0.982–1.010, median 1.000; the non-SOL one correctly not treated as SOL |
| PumpSwap | GeckoTerminal price | 12 | price ratio 0.994–1.035, median 1.003 (after turning SOL-first pools round; before, 6 of 12 hops in the Jupiter test read as non-SOL) |
| Raydium LaunchLab | Jupiter hop | 7 | ratio 0.978–0.990, median 0.9875 |
| Raydium LaunchLab | GeckoTerminal price | 6 SOL-quoted | 0.99–1.016 once the protocol fee sitting in the quote vault was taken out (before: 1.06–1.075, because the vault holds the real quote *plus* the fee: `vault = real_quote + quote_protocol_fee` exactly, checked on 8 pools); a migrated pool reads as closed |
| Raydium AMM v4 | Jupiter hop | 2 | ratio 0.9975 |
| Raydium CPMM | Jupiter hop | 1 | ratio 0.9816 |
| Meteora DAMM v2 | Jupiter hop | 3 (+1 earlier) | ratio 0.980–0.990, after fixing the liquidity scale (liquidity is Q64.64 like the prices; before the fix the effective reserve came out 2^64 too large) |
| Meteora DBC | GeckoTerminal price | 6 live (not migrated) | price ratio 0.969–1.007, median 1.0016; migrated pools read as closed and their stored price is stale, as expected |

Not verified, and why:
- **Raydium CPMM and AMM v4 on more than a handful of pools**: GeckoTerminal's listing for these two returned 404 for the dex ids tried, and the Jupiter hop check found few. Both reproduced Jupiter's output within the fee tier on the pools that were found, but n is 1 and 2.
- **DAMM v2 with SOL as token A**: no live example turned up in the samples; the orientation logic is covered by a unit test only.
- **DBC exit capacity**: the curve is piecewise; the decoder reports price and the SOL held, and its capacity is labelled approximate. Not checked against a quote at size.
- **Orca Whirlpools, Raydium CLMM, Meteora DLMM, proprietary AMMs**: not decoded (tick arrays, bins, or no on-chain state), by design. The inspector says "not read".
- **Pool "status" fields**: PumpSwap and Raydium AMM v4 status are not used to mark a pool closed (AMM v4's status values were not confirmed). CPMM's bit 2 and DAMM v2's `pool_status` are decoded from the source and covered by unit tests, not seen live.

Findings that came out of the check and changed the code:
- PumpSwap pools can list SOL as the *base* mint; they have to be turned round so SOL is the quote.
- A pump.fun curve can be paired with something other than SOL (quote mint at offset 83); reading it as SOL gives reserves 1000× off.
- LaunchLab's quote vault includes owed fees.
- DAMM v2 liquidity scale.
- The Dynamic Bonding Curve names neither its quote mint nor its price directly in a form the generic view used: its mints come from its vaults and its price from its own sqrt price.
