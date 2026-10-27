# Solana token mints and programs for a trading bot: what to read and how it changes a trade

Scope: Solana only, as of 2026-10-27. Public docs and GET only. Tags: [V] = read on the cited page or source file in this session; [I] = my inference or general knowledge, not confirmed on a page I read; [S] = single source or vendor/community source. Builds on (not repeating) `Rug detection for copy trading/pre_buy_checks.md` section 1 and `rug_taxonomy_timing.md` (Token-2022 trap list, Mayhem basics). New here: extension-by-extension DEX support matrices, byte-level detection facts, program/loader mechanics, transaction-resolution rules.

---

## 1. Token mints: SPL Token vs Token-2022, layout, authorities, and how a bot reads them

### Takeaway
There are two token programs (legacy SPL Token and Token-2022 "Token Extensions") and the mint is an 82-byte base struct (mint authority, supply, decimals, initialized flag, freeze authority); Token-2022 appends a TLV extension list after byte 165. A bot gets all of it from one `getAccountInfo` on the mint (jsonParsed gives the extension list already decoded), and `getTokenSupply` gives supply with decimals.

### Cited Findings
- Token-2022 program id is `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. [V] — [solana-program/token-2022 README](https://raw.githubusercontent.com/solana-program/token-2022/main/README.md); also used as `token_program` by pump.fun `create_v2` — [pump-public-docs COIN_CREATION](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/instructions/COIN_CREATION.md)
- Legacy SPL Token program id and the Associated Token Account program id were not printed on any page I read (Solana docs reference them only via constants). The legacy id is `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` and the ATA program id `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` from general knowledge. [I] — [Solana docs: create token account](https://solana.com/docs/tokens/basics/create-token-account) (confirms the page names but does not print them)
- Mint struct fields: `mint_authority` (optional), `supply`, `decimals`, `is_initialized`, `freeze_authority` (optional). "If no mint authority is present then the mint has a fixed supply and no further tokens may be minted." [V] — [Solana docs: create mint](https://solana.com/docs/tokens/basics/create-mint)
- Base mint is 82 bytes; base token account is 165 bytes; with extensions, an account-type byte sits at index 165 (0 Uninitialized, 1 Mint, 2 Account), followed by a TLV list: type u16 LE, length u16 LE, then value; a type of 0 ends used space. A 355-byte account is special-cased as a multisig. [V] — [token-2022 interface `extension/mod.rs`](https://raw.githubusercontent.com/solana-program/token-2022/main/interface/src/extension/mod.rs)
- ExtensionType discriminants (u16): 1 TransferFeeConfig, 2 TransferFeeAmount, 3 MintCloseAuthority, 4 ConfidentialTransferMint, 5 ConfidentialTransferAccount, 6 DefaultAccountState, 7 ImmutableOwner, 8 MemoTransfer, 9 NonTransferable, 10 InterestBearingConfig, 11 CpiGuard, 12 PermanentDelegate, 13 NonTransferableAccount, 14 TransferHook, 15 TransferHookAccount, 16 ConfidentialTransferFeeConfig, 17 ConfidentialTransferFeeAmount, 18 MetadataPointer, 19 TokenMetadata, 20 GroupPointer, 21 TokenGroup, 22 GroupMemberPointer, 23 TokenGroupMember, 24 ConfidentialMintBurn, 25 ScaledUiAmount, 26 Pausable, 27 PausableAccount, 28 PermissionedBurn. [V] — same file. (`PermissionedBurn` is not on the Solana docs extension overview page, so it is newer than the docs list.)
- Solana docs list these mint extensions: TransferFeeConfig, MintCloseAuthority, ConfidentialTransferMint, ConfidentialTransferFeeConfig, ConfidentialMintBurn, DefaultAccountState, NonTransferable, InterestBearingConfig, PermanentDelegate, TransferHook, MetadataPointer, TokenMetadata, GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember, ScaledUiAmount, Pausable; and account extensions TransferFeeAmount, ConfidentialTransferAccount, ConfidentialTransferFeeAmount, ImmutableOwner, MemoTransfer, CpiGuard, NonTransferableAccount, TransferHookAccount, PausableAccount. Most extensions must be enabled at account creation and generally cannot be added later; some conflict (NonTransferable cannot be combined with TransferFeeConfig). [V] — [Solana docs: Token extensions](https://solana.com/docs/tokens/extensions)
- `getAccountInfo` with `jsonParsed` returns `{program, parsed, space}`, falling back to `[data, "base64"]` when no parser exists. Result fields: `lamports`, `owner` (program owner), `data`, `executable`, `rentEpoch`, `space`. `dataSlice` does not work with jsonParsed. `base58` is limited to 128 bytes and the RPC still defaults to deprecated `binary`, so set encoding explicitly. [V] — [Solana RPC getAccountInfo](https://solana.com/docs/rpc/http/getaccountinfo)
- `getTokenSupply` returns `amount` (raw string), `decimals`, `uiAmount` (deprecated float) and `uiAmountString`. The page says nothing about Token-2022 UI scaling. [V] — [Solana RPC getTokenSupply](https://solana.com/docs/rpc/http/gettokensupply)
- Freeze/thaw in Token-2022 source: freeze requires a freeze authority on the mint (else `MintCannotFreeze`); a frozen source or destination makes `process_transfer` fail with `AccountFrozen`; frozen accounts also cannot approve, revoke, set authority, mint to, or burn. [V] — [token-2022 processor.rs (first 100k chars read)](https://raw.githubusercontent.com/solana-program/token-2022/main/program/src/processor.rs)
- Helius' reading guide: mint authority null = nobody can mint more (memecoin launchpads set it to null); freeze authority present = holder "can be locked out of selling"; absent authority row = none. [V][S] — [Helius Orb: explore authorities](https://www.helius.dev/docs/orb/explore-authorities)
- Practical mint-read rule from Neodyme: keep an allowlist of extensions via `get_extension_types()` and check authorities of every accepted mint, not just extensions. [V] — [Neodyme: SPL Token-2022](https://neodyme.io/en/blog/token-2022/)

### Inferences
- Legacy mint byte layout (36-byte COption mint authority, u64 supply at offset 36, decimals at 44, init flag at 45, 36-byte COption freeze authority from 46) follows from the struct order above and the 82-byte size; verify against `jsonParsed` before hand-decoding. [I]
- Cheapest bot path: one `getAccountInfo(mint, jsonParsed)` returns program owner (which of the two token programs), `mintAuthority`, `freezeAuthority`, `supply`, `decimals` and the parsed `extensions` array. `owner` of the mint account itself tells you legacy vs Token-2022, which you also need to derive the correct ATA (the token program id is a seed, see section 3). [I]
- When hand-decoding Token-2022 mints, an account whose data length is 82 has no extensions; length above 165 with byte 165 = 1 means a mint with a TLV list. [I, from the layout above]

### Gaps
- Whether `jsonParsed` already decodes every newer extension (Pausable, ScaledUiAmount, PermissionedBurn) on current public RPC nodes was not tested (no live RPC call made; instruction said GET docs only). Check with a live call before relying on parsed names.
- The byte-level layout of each extension's value (e.g. TransferFeeConfig field offsets) was not read; only the fields via docs.

---

## 2. Token-2022 extensions: detect, what each does to a swap, and who supports it

### Takeaway
Only the extensions that change the amount that moves (TransferFee, plus hook-driven and pause/freeze behaviour) matter to the received-amount calculation; permanent delegate, pausable, default-frozen, close authority, hooks and non-transferable are all rug/lock-in vectors. Raydium CPMM/CLMM (verified in source) allow only five harmless extensions at pool creation; Orca gates the risky ones behind manual TokenBadges; Jupiter routing of hook mints is reported to be poor.

### Cited Findings

**TransferFeeConfig (mint) / TransferFeeAmount (account)**
- Mint fields: `transferFeeConfigAuthority`, `withdrawWithheldAuthority`, `withheldAmount`, `olderTransferFee`, `newerTransferFee`; each fee struct has `epoch`, `maximumFee`, `transferFeeBasisPoints`. [V] — [Solana docs: transfer fees](https://solana.com/docs/tokens/extensions/transfer-fees)
- `SetTransferFee` writes the newer config, which "takes effect starting two epochs later"; initialization sets both older and newer to the initial fee. The transferred amount is reduced by the fee; withheld fees accumulate on the destination token account (`TransferFeeAmount`); harvest to mint is permissionless, withdrawal needs `withdrawWithheldAuthority`. The docs page does not give the formula or a bps maximum. [V] — same page
- Fee formula in practice: `fee = min(amount * bps / 10_000, maximum_fee)`; the fee is taken from the amount received, not from the sender's balance; an account with non-zero `withheld_amount` cannot be closed. [V] — [Raydium: Token-2022 transfer fees](https://docs.raydium.io/algorithms/token-2022-transfer-fees) and [Neodyme](https://neodyme.io/en/blog/token-2022/); the Raydium source treats `bps == MAX_FEE_BASIS_POINTS` as a flat `maximum_fee` in the inverse calculation — [raydium-cp-swap `utils/token.rs`](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/utils/token.rs)
- Effect on a swap (Raydium CPMM math): `vault_received = amount_in - fee_in`; pool fee on that; curve output `amount_out_gross`; `user_receives = amount_out_gross - fee_out`. The slippage check (`minAmountOut`) is compared to the gross amount the pool sends, not what the user receives. A 1% transfer-fee mint on both sides of a 0.25% pool costs about 2.25%, not 0.25%. During a rate transition the older/newer configs are selected by current epoch, so quotes made epochs ahead can differ from execution. [V][S] — [Raydium docs](https://docs.raydium.io/algorithms/token-2022-transfer-fees) and [Raydium Token-2022 support](https://docs.raydium.io/reference/token-2022-support)
- Orca Whirlpool semantics: for exact-in, `amount` is fee-included (leaves user's account) and `otherAmountThreshold` is fee-excluded (what user receives); for exact-out the reverse; so slippage is set on actual account deltas. `two_hop_swap_v2` moves tokens directly pool-to-pool to avoid double fees. [V] — [Orca token extensions](https://docs.orca.so/developers/architecture/token-extensions)
- Jupiter: said in 2023 it supported transfer fees "across the entire stack" (backend, UI, aggregator program) and put Token-2022 in a separate token list; the post is archived and says Token-2022 was "still undergoing development". [V] — [Jupiter forum archive](https://discuss.jup.ag/t/archived-jupiter-token-2022-support/21711) (the docs.jup.ag blog URL returned 404). An open issue reports quotes through Manifest legs overstate `outAmount` by the transfer fee (adapter ignores the fee), causing slippage reverts. [V][S] — [jupiter-swap-api-client issue 65](https://github.com/jup-ag/jupiter-swap-api-client/issues/65)

**TransferHook (mint) / TransferHookAccount**
- Mint stores the hook program id; on each transfer Token-2022 CPIs into the program's `Execute`; an error from the hook fails the transfer. The hook's extra accounts live in a PDA with seeds `"extra-account-metas"`, mint, hook program id. The sender's signer privileges are not extended to the hook; accounts reach it read-only. [V] — [Solana docs: transfer hook](https://solana.com/docs/tokens/extensions/transfer-hook)
- Hook program can be changed by the hook authority later ("Update the transfer hook program"), and whether the hook program itself is upgradeable is a separate check. [V] — [Neodyme](https://neodyme.io/en/blog/token-2022/)
- Detection: `TransferHook` in the mint's extensions with non-null `programId`; then read the hook program's loader state (section 5) for its upgrade authority. [I]
- Raydium CPMM/CLMM: `TransferHook` rejected by default at pool creation (`NotSupportMint`); the check is only at creation, "no swap-time mint check". [V][S] — [Raydium Token-2022 support](https://docs.raydium.io/reference/token-2022-support). Orca: allowed only with an initialized TokenBadge. [V] — [Orca](https://docs.orca.so/developers/architecture/token-extensions).
- Jupiter and hooks: a single community investigation reports Jupiter's Metis router and Titan find no routes for live transfer-hook mints, while DFlow and OKX routes do; the same source says Jupiter limit orders and DCA reject hook mints unless whitelisted. Not confirmed by Jupiter docs. [S] — summary from the search result for [top-pad issue 22](https://github.com/imDev2023/top-pad/issues/22) (page not opened).

**PermanentDelegate**
- Mint-level authority that "can authorize transfers and burns for any token account for that mint"; delegate-signed transfers process as if the owner signed; account owners cannot revoke it; mint authority can rotate it via `SetAuthority` (PermanentDelegate). [V] — [Solana docs: permanent delegate](https://solana.com/docs/tokens/extensions/permanent-delegate)
- Pool vaults can be drained by the delegate even if pool logic is correct. [V] — [Neodyme](https://neodyme.io/en/blog/token-2022/)
- Raydium CPMM/CLMM reject it by default; Orca requires a TokenBadge. [V][S] — links above.

**Pausable (mint) / PausableAccount**
- `PausableConfig` holds `authority` and `paused`; while paused the Token Extension program rejects transfers, mints and burns; resume restores them. [V] — [Solana docs: pausable](https://solana.com/docs/tokens/extensions/pausable)
- Raydium: Pausable rejected by default (listed under "unreviewed"); Orca: not in its supported list, so falls under "not supported". [V][S] — links above.

**DefaultAccountState**
- New token accounts for the mint can start `Frozen`; freeze authority can later change the default; vault/escrow creation can break. [V] — [Neodyme](https://neodyme.io/en/blog/token-2022/). (Solana docs page `.../default-account-state` returned 404 when fetched.)
- Raydium: rejected by default when Frozen; Orca: supported only with a TokenBadge and only with default state Initialized. [V][S]

**NonTransferable (mint) / NonTransferableAccount**
- Tokens cannot be moved; owner can still burn and close the account (unlike frozen). Cannot combine with TransferFeeConfig. [V] — [Neodyme](https://neodyme.io/en/blog/token-2022/) and [Solana docs overview](https://solana.com/docs/tokens/extensions). Raydium rejects, Orca "not supported". [V][S]

**MintCloseAuthority**
- Mint can be closed when supply is zero (`MintHasSupply` otherwise); token accounts remain; the Token-2022 program allows re-initializing a mint at the same address, so old accounts can attach to a new mint with different rules. Rejecting closeable mints is not enough because a once-closeable mint may now be non-closeable. [V] — [Neodyme](https://neodyme.io/en/blog/token-2022/) and [processor.rs](https://raw.githubusercontent.com/solana-program/token-2022/main/program/src/processor.rs). Raydium rejects by default; Orca requires a TokenBadge. [V][S]

**ConfidentialTransfer (+ fee, mint/burn)**
- Only transfer amounts and balances are private; token account addresses stay public; an optional auditor key can decrypt transfer amounts; the mint authority controls account approval and auto-approval; the standard transfer instruction cannot be used for confidential transfers. [V] — [Solana docs: confidential transfer](https://solana.com/docs/tokens/extensions/confidential-transfer) and [Neodyme](https://neodyme.io/en/blog/token-2022/)
- Raydium rejects `ConfidentialTransferMint` ("encrypted amounts can't be priced by the curve"); Orca supports it for non-confidential transfers only. [V][S]
- Balance changes of confidential accounts will not show in plain `uiTokenAmount` movements. [I]

**InterestBearingConfig and ScaledUiAmount (display-only rebasing)**
- InterestBearing: raw balance does not change; UI amount is computed from `last_update_timestamp`, `pre_update_average_rate`, `current_rate`; `rateAuthority` can change the rate; "the UI amount can rise while the raw token amount and supply stay the same, so don't treat the UI amount as a balance change." [V] — [Solana docs: interest-bearing](https://solana.com/docs/tokens/extensions/interest-bearing-tokens)
- ScaledUiAmount: fields `authority`, `multiplier`, `new_multiplier`, `new_multiplier_effective_timestamp`; only displayed amount changes, raw amounts stay; UI amount = `trunc(amount x multiplier)` / 10^decimals; value can change at the effective timestamp with no account write; floating-point means round trips are not exact; cannot be on the same mint as InterestBearing. [V] — [Solana docs: scaled UI amount](https://solana.com/docs/tokens/extensions/scaled-ui-amount)
- Raydium allows both (pool sees principal); Orca supports InterestBearing, ScaledUiAmount is not in its list. [V][S]

**MetadataPointer / TokenMetadata / GroupPointer / GroupMemberPointer / TokenGroup / TokenGroupMember**
- MetadataPointer holds an authority and a metadata address (any account owned by a program implementing the token-metadata interface); TokenMetadata stores `name`, `symbol`, `uri`, `update_authority`, `mint`, `additional_metadata`; clearing the update authority makes metadata immutable; metadata updates can resize the mint (rent top-up needed). [V] — [Solana docs: metadata](https://solana.com/docs/tokens/extensions/metadata)
- Group/member extensions describe collections; no swap effect. Raydium lists them as rejected by default ("unreviewed"), Orca "not supported"; this means a pump-style token with a group pointer would fail to get a Raydium CPMM pool. [V][S]

**Support summary (Raydium CPMM/CLMM source-verified)**
- `is_supported_mint` returns true for legacy SPL Token mints, for mints with an initialized `SupportMintAssociated` PDA, or when every extension is one of `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata`, `InterestBearingConfig`, `ScaledUiAmount`. [V] — [raydium-cp-swap `utils/token.rs`](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/utils/token.rs)
- Raydium AMM v4: classic SPL Token mints only. Raydium docs say a static `MINT_WHITELIST` bypass was removed in 2026-07/09 upgrades; existing pools keep trading. [S: docs only; the CP-swap source I read shows the registry PDA, not a static whitelist] — [Raydium Token-2022 support](https://docs.raydium.io/reference/token-2022-support)
- Orca: supported without badge = TransferFee, InterestBearing, MemoTransfer, MetadataPointer, TokenMetadata, ConfidentialTransfer (non-confidential only); with TokenBadge = PermanentDelegate, TransferHook, MintCloseAuthority, DefaultAccountState (Initialized only), plus freeze authority on Token-2022 mints; not supported = Group, GroupPointer, Member, MemberPointer, NonTransferable and anything else unlisted. Freeze authority rule applies to Token-2022 tokens, not legacy tokens. [V] — [Orca token extensions](https://docs.orca.so/developers/architecture/token-extensions)
- Orca says a badge is not an endorsement or a liquidity guarantee. [V][S] (search summary of Orca pages)

### Inferences
- A pool existing is a weak safety signal for extensions: Raydium's allow-list is checked at pool creation only, so a mint that adds an extension later (extensions are "generally" fixed at creation, but authorities can swap a hook program or rotate a delegate/rate) is not re-checked. [I]
- Receive-amount prediction for a transfer-fee token: expected received = `gross - min(gross*bps/10_000, max_fee)` on each leg that touches the token; read BOTH `olderTransferFee` and `newerTransferFee` and pick by current epoch (`newer` applies when `newer.epoch <= current_epoch`). Raydium's TS rule is "use older if its epoch is at or before the current epoch, else newer" per its docs (they describe it with the labels reversed relative to the Solana docs; check the epoch field rather than the label). [I, from conflict between sources]
- Detection ranking for a copy bot: hard block on PermanentDelegate, Pausable, NonTransferable, DefaultAccountState=Frozen, ConfidentialTransfer, MintCloseAuthority, TransferHook with unvetted program; soft-flag TransferFee (price in the fee), InterestBearing/ScaledUiAmount (display-only, parse raw amounts), metadata/group pointers (benign). [I]

### Gaps
- Jupiter's current official policy on hooks, permanent delegate, pausable, confidential tokens: no official page found; only the 2023 archived post, a transfer-fee API-client issue and one community report. Jupiter's `docs.jup.ag/blog/jup-token2022-support` link 404'd.
- Meteora DLMM/DAMM and PumpSwap Token-2022 extension policies: not researched/fetched. PumpSwap handles Token-2022 for `create_v2` coins but its extension allow-list is not documented in pages I read.
- Solana docs pages for default-account-state, non-transferable, mint-close-authority returned 404; those rely on Neodyme and source code.
- Raydium docs and Orca docs contain internally inconsistent statements (Raydium conceptual pages vs the reference matrix on hooks; Orca overview vs architecture pages on DefaultAccountState/MintCloseAuthority). I resolved Raydium via source; Orca not source-verified.

---

## 3. Metadata and identity (Metaplex Token Metadata, Token-2022 metadata)

### Takeaway
Legacy tokens carry a Metaplex Metadata PDA (update authority, `isMutable`, name/symbol/URI, creators); Token-2022 tokens can embed name/symbol/URI on the mint via MetadataPointer+TokenMetadata (pump.fun `create_v2` uses this). Mutable metadata lets an authority change name/symbol/URI after launch, so identity fields are only trustworthy if mutability is revoked, and name/symbol are not unique so copycat detection must key on mint address and URI content.

### Cited Findings
- Metaplex Token Metadata account: ties to a mint through a PDA derived from the mint; fields include `name`, `uri`, `seller_fee_basis_points` ("purely indicative", not enforced), `creators` (each with `verified` flag and share), `is_mutable`, `token_standard` (computed, not manually updatable: NonFungible, NonFungibleEdition, FungibleAsset, Fungible, ProgrammableNonFungible). Metaplex calls Token Metadata a legacy program and recommends Core for new projects. [V] — [Metaplex Token Metadata](https://metaplex.com/docs/token-metadata)
- Struct order: `key`, `update_authority`, `mint`, `data` (name, symbol, uri, seller_fee_basis_points, creators), `primary_sale_happened`, `is_mutable`, `edition_nonce`, `token_standard`, `collection`, `uses`, `collection_details`, `programmable_config`; limits `MAX_NAME_LENGTH` 32, `MAX_SYMBOL_LENGTH` 10, `MAX_URI_LENGTH` 200. [V] — [mpl-token-metadata `state/metadata.rs`](https://raw.githubusercontent.com/metaplex-foundation/mpl-token-metadata/main/programs/token-metadata/program/src/state/metadata.rs)
- Update instruction: the update authority (or certain delegates) can change name, symbol, URI, seller fee, creators (only unverified creators can be added/removed unless creator is the update authority), `primary_sale_happened`, collection, and can set a new update authority; setting `isMutable` to false makes every future update fail. [V] — [Metaplex: update](https://metaplex.com/docs/token-metadata/update)
- Helius: `Mutable` false on Orb means the Metaplex update authority was revoked; revoking update authority is described as the default for new Pump.fun tokens. [V][S] — [Helius Orb](https://www.helius.dev/docs/orb/explore-authorities)
- pump.fun `create_v2`: instruction args `name`, `symbol`, `uri` with maximum 32, 13 and 200 characters; the only Token-2022 extension named is a metadata pointer whose address is the mint itself (so metadata lives on the mint). The doc does not mention Metaplex for `create_v2`. The legacy `create` (token program: legacy SPL Token) uses Metaplex metadata per Chainstack. [V][S] — [pump COIN_CREATION](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/instructions/COIN_CREATION.md); [Chainstack](https://chainstack.com/trading-bot-update-full-mayhem-mode-support-for-pump-fun/)
- Token-2022 metadata can be read through `Emit` (return data) or the mint account's TokenMetadata TLV; `UpdateField` changes base fields; `RemoveKey` removes only custom keys; base fields cannot be removed; update-authority can be cleared to make it immutable. [V] — [Solana docs: metadata](https://solana.com/docs/tokens/extensions/metadata)

### Inferences
- Identity fields for copycat detection: `name`, `symbol` (case-fold, strip padding, normalize unicode), `uri` JSON (image hash, description), creators list, and the mint address. Copycats reuse name+symbol; the genuine one is established by mint address provenance (what the leader actually bought), not by name. [I]
- For Metaplex names, expect right-padded null bytes (the padding behaviour was not confirmed in the code excerpt; metaplex `puff_out_data_fields` implies padding), so trim `\0`. [I]
- Mutable metadata risk: after the buy a mutable authority can swap URI/name (rebrand) but cannot change balances; risk is reputational/phishing rather than a loss-of-funds vector. [I]
- Because pump `create_v2` metadata sits on the mint, the metadata authority is the Token-2022 `update_authority` of the TokenMetadata extension; I did not find who it is by default. [I]

### Gaps
- Metaplex program id `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` and the exact Metadata PDA seeds (`"metadata"`, program id, mint) were not printed on the pages read. [I] unsourced.
- Who holds the update authority/immutability state on pump.fun `create_v2` TokenMetadata: not documented in pages read.
- Whether name/symbol uniqueness or an on-chain verification exists: none found.

---

## 4. Token accounts: ATAs, rent, wSOL, close/freeze/delegate, and mapping balance changes to buys/sells

### Takeaway
A holder's balance for a mint is a token account (an ATA by default) whose `owner` field is the wallet; swaps create/close wSOL and ATAs in the same transaction, so SOL deltas include rent and wrap/unwrap noise, and token deltas for Token-2022 mints need transfer-fee and rebasing awareness. Use `preTokenBalances/postTokenBalances` keyed by (owner, mint) for token flow and `preBalances/postBalances` for SOL, not account-level raw lamports.

### Cited Findings
- ATA derivation: `find_program_address` over [wallet, token program id, mint] with the Associated Token Program as the program; exactly one ATA per (wallet, token program, mint). The ATA's program owner is the token program (not the ATA program). [V] — [Solana docs: create token account](https://solana.com/docs/tokens/basics/create-token-account)
- Token account struct: `mint`, `owner`, `amount`, `delegate`, `state`, `is_native`, `delegated_amount`, `close_authority`. `owner` is the authority that can transfer/burn/delegate. [V] — same page
- Rent: 165-byte ATA = 2,039,280 lamports (0.00203928 SOL); Token-2022 ATA with ImmutableOwner (170 bytes) = 2,074,080 lamports (0.00207408 SOL); larger extension accounts cost more, so query `getMinimumBalanceForRentExemption`; rent is refundable on close and goes to the close instruction's destination, not necessarily the original payer. [V] — same page
- wSOL: native mint `So11111111111111111111111111111111111111112` (Token program); Token-2022's native mint is `9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP`. The SOL sits in the account's lamports; `amount` is stale until `SyncNative`, which sets `amount = lamports - rent_reserve`. [V] — [Solana docs: sync native](https://solana.com/docs/tokens/basics/sync-native); processor `process_sync_native` confirms. [V] — [processor.rs](https://raw.githubusercontent.com/solana-program/token-2022/main/program/src/processor.rs)
- Close: `process_close_account` rejects non-native accounts with a non-zero balance; authority is the close authority if set, else the owner; confidential/transfer-fee extensions must be `closable()` (withheld fees block closing). [V] — processor.rs; [Neodyme](https://neodyme.io/en/blog/token-2022/)
- Frozen accounts cannot transfer in or out and cannot burn, approve, revoke or change authority. [V] — processor.rs
- `getTransaction` token balances: each entry has `accountIndex`, `mint`, `owner` (optional, "when the validator recorded it"), `programId` (optional), and `uiTokenAmount` {`amount` raw string, `decimals`, `uiAmount` (deprecated), `uiAmountString`}. `innerInstructions` may be null; `loadedAddresses` has ordered `writable` and `readonly`; return data appears in logs as `Program return: <programId> <base64>`. [V] — [Solana RPC getTransaction](https://solana.com/docs/rpc/http/gettransaction)
- Withheld transfer fees sit on the destination token account in `TransferFeeAmount`; transferred amount is reduced by the fee. [V] — [Solana docs: transfer fees](https://solana.com/docs/tokens/extensions/transfer-fees)

### Inferences
- Classification rule (suggested): for a leader wallet W and mint M, find the token account(s) with `owner == W` in post minus pre; positive delta with a corresponding negative SOL/wSOL/USDC delta in the same transaction = buy; negative = sell; negative with no counter-leg paid to W = transfer out; a delta with no corresponding swap-program inner instruction = plain transfer. Aggregate by (owner, mint), not by token account, because a leader can hold multiple accounts and an account created in the same transaction has no `pre` entry (treat missing pre as 0). [I]
- Pitfalls: (1) ATA creation in the same transaction adds a rent debit (about 0.00203928 SOL, or 0.00207408 for Token-2022 ImmutableOwner) to the SOL delta that is not part of the price; (2) wSOL wrap/unwrap shows as SOL deltas and as a wSOL balance that appears and disappears (closing a wSOL account returns all lamports including rent); (3) pre/post `owner` can be missing, so fall back to reading the account's `owner` field from `getAccountInfo` (or from the account's creation instruction); (4) Token-2022 transfer fees: the buyer receives less than the pool sent, and a "sell" of N tokens delivers N minus fee to the pool, so price per token computed from raw deltas must use the received amount on each side; (5) rebasing/UI-multiplier mints: use raw `amount`, never `uiAmount`; (6) `uiAmount` is deprecated and a float, use `amount` + `decimals`; (7) burned or closed accounts disappear from post balances; (8) delegated spending (`delegate`/`delegated_amount`) can move tokens without the owner signing the transaction, so a balance drop with no owner signature is a delegate or permanent-delegate action. [I]

### Gaps
- Behaviour of `preTokenBalances` for Token-2022 accounts with confidential balances: not documented in pages read.
- Fetching wSOL close semantics from the Solana tutorial: the sync-native page links to a close tutorial that I did not open; behaviour inferred from the close processor code.
- Compute budget and Jito tip details are in section 6.

---

## 5. Programs: loader v3/v4, upgrade authority, verification, and what an upgrade authority implies

### Takeaway
Under loader v3 (BPF Loader Upgradeable) a program id is a small account pointing to a ProgramData account that holds the bytecode, the last-deploy slot and the upgrade authority; `Authority: none` means immutable. A DEX or launch program with a live upgrade authority can be replaced by whoever holds that key, so the risk depends on whether it is a single hot key, a multisig, or burned, and whether the on-chain hash matches a verified build.

### Cited Findings
- Program account: `executable = true`; for loader v3, it stores the ProgramData address; ProgramData stores executable code plus slot metadata and `upgrade_authority_address`. Upgrade authority "defaults to the CLI wallet that deployed it"; `solana program set-upgrade-authority <id> --final` removes it, showing `Authority: none`, and "Once a program is immutable, it can never be updated or closed." [V] — [Solana docs: deploying programs](https://solana.com/docs/programs/deploying); [Solana docs: program deployment](https://solana.com/docs/core/programs/program-deployment)
- Loader v3 enum: `Uninitialized`, `Buffer { authority_address: Option<Pubkey> }`, `Program { programdata_address }`, `ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }`. [V] — [docs.rs solana-loader-v3-interface](https://docs.rs/solana-loader-v3-interface/latest/solana_loader_v3_interface/state/enum.UpgradeableLoaderState.html)
- Loader ids: Native Loader `NativeLoader1111111111111111111111111111111`, BPF Loader v1 `BPFLoader1111111111111111111111111111111111`, v2 `BPFLoader2111111111111111111111111111111111` (both non-upgradeable legacy), BPF Loader Upgradeable (loader-v3) `BPFLoaderUpgradeab1e11111111111111111111111`. Loader v3 is described as the current default loader. [V] — [Solana docs: program deployment](https://solana.com/docs/core/programs/program-deployment)
- Upgrade semantics: new bytecode takes effect in `deployment_slot + 1`; a program cannot be upgraded in its deploy slot; `SetAuthority` to None makes it immutable; Close on ProgramData is possible only while an authority exists. [V] — same page
- Loader v4: `LoaderV4State { slot, authority_address_or_next_version, status }`; when finalized, the authority field points to the next version of the program. The docs.rs page did not list status variants. [V] — [docs.rs solana-loader-v4-interface](https://docs.rs/solana-loader-v4-interface/latest/solana_loader_v4_interface/state/struct.LoaderV4State.html). The program-deployment page does not mention loader v4. [V]
- Verified builds: deterministic Docker build (`solana-verify`), a PDA owned by verify program `verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC` stores program address, git URL, commit and build args; OtterSec's API rebuilds from that data; status endpoints `https://verify.osec.io/status/<program-id>`, `/job/<job-id>`, `/verified-programs`. Verified is "not more secure than an unverified build"; only the upgrade authority's PDA counts as valid, so immutable programs need whitelisting; the API un-verifies programs after an upgrade and re-verifies every 24 hours; public source only; mainnet only. [V] — [Solana docs: verified builds](https://solana.com/docs/programs/verified-builds)
- Upgrade authority risk: "most Solana programs have a single hot wallet upgrade authority" (Solend example; Mango DAO-controlled; Coral non-upgradeable); an authority can replace code and take deposited funds so audits alone do not rule out a rug; checks: Explorer `Upgradeable` and `Upgrade Authority` fields, `Last Deployed Slot`, authority tx patterns (many tx in the same slot suggest hot wallet), and whether the on-chain binary matches published source. [V][S] — [Neodyme: Solana upgrade authority](https://neodyme.io/blog/solana_upgrade_authority/)
- Serum case: its program update key was reportedly tied to an FTX-linked key rather than the DAO, and protocols including Jupiter and Phantom delisted Serum. [S, search summary] — [unchainedcrypto](https://unchainedcrypto.com/?p=7248) (not opened); other results cover Squads multisig management ([Squads blog](https://squads.so/blog/solana-multisig-program-upgrades-management), not opened).
- Jupiter publishes a program-id to label map (`https://lite-api.jup.ag/swap/v1/program-id-to-label`): a flat JSON object, 111 entries when fetched, covering e.g. Raydium (`675kPX9MHT…`), Raydium CLMM (`CAMMCzo5YL…`), Raydium CP (`CPMMoo8L3F…`), Raydium Launchlab (`LanMV9sAd7…`), Orca Whirlpool (`whirLbMiic…`), Meteora DLMM (`LBUZKhRxPF…`), Meteora DAMM v2 (`cpamdpZCGK…`), Pump.fun (`6EF8rrecth…`), Pump.fun Amm (`pAMMBay6oc…`); labels can repeat across addresses. The fetched summary truncated addresses, so fetch the JSON directly to get full ids. [V] — [Jupiter lite-api program-id-to-label](https://lite-api.jup.ag/swap/v1/program-id-to-label)
- Program ids documented elsewhere in this research: pump.fun `create_v2` mint authority is a Pump PDA with seed `[b"mint-authority"]`. [V] — [pump COIN_CREATION](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/instructions/COIN_CREATION.md)

### Inferences
- Reading a program: `getAccountInfo(programId)`; if `owner == BPFLoaderUpgradeab1e...` and `executable`, parse `programdata_address`; `getAccountInfo(programdata)` and read slot and optional authority (jsonParsed returns `{type:"program", info:{programData}}` for the program and `{type:"programData", info:{authority, slot, data}}` for the ProgramData account in my experience). If the owner is v1/v2 loader the program is immutable; if the owner is loader v4, use `LoaderV4State.status` and `authority_address_or_next_version`. [I]
- Genuine-DEX verification ladder: (1) program id appears in the bot's pinned allow-list copied from the DEX's own docs/repo; (2) Jupiter's `program-id-to-label` label matches the claimed DEX; (3) OtterSec `status/<id>` shows verified against the DEX's public repo; (4) upgrade authority is a known multisig or none. No single registry is authoritative; none of Helius labels, Solscan labels or Solana program registries were opened here. [I]
- Risk reading: upgradeable DEX program with a single-key authority = non-zero rug/exploit tail risk for resting liquidity, but it does not change the per-trade math for a short-horizon copy trade; a launchpad whose curve program is upgradeable can retroactively change fee, curve and migration rules (pump.fun has done several fee-regime changes per `rug_taxonomy_timing.md`). Treat an authority change or fresh deploy slot on a trading program as an alert condition and pause. [I]
- Hook programs matter more than DEX programs here: a hook with a live upgrade authority can turn a benign token into a trap after you buy. [I, combines Neodyme hook-update statement with loader semantics]

### Gaps
- Helius labels, Solscan labels, and the Solana program registry (Anchor/OtterSec registry) were not fetched; only Jupiter's list was read. Whether Jupiter's list is complete or maintained for new DEXs: unknown.
- Loader v4 mainnet adoption/status in 2026: the search returned only localized copies of the old docs page; not determined. LoaderV4Status variants not confirmed.
- ProgramData byte offsets (header size, the Option<Pubkey> encoding) not read; use `jsonParsed`.
- Pump.fun, PumpSwap, Raydium, Orca upgrade authorities and verification status: not queried (would need live RPC/OtterSec call).

---

## 6. Account ownership, transaction semantics, ALTs, inner instructions, priority fees and Jito tips

### Takeaway
Holder lists from token accounts contain pool vaults, curve accounts, escrow and other program-controlled accounts as "owners", so each `owner` must be classified (system-owned wallet vs program-owned account vs PDA) before concentration stats mean anything. To know which programs a transaction really called, a bot must resolve versioned-transaction lookup tables (account keys = static + loaded writable + loaded readonly) and walk inner instructions, since routers like Jupiter call DEX programs via CPI.

### Cited Findings
- A token account's program owner is the token program; its `owner` field is the authority. ATAs are PDAs derived from (wallet, token program, mint). [V] — [Solana docs: create token account](https://solana.com/docs/tokens/basics/create-token-account)
- Account RPC `owner` = program that owns the account; `executable` flags programs. [V] — [getAccountInfo](https://solana.com/docs/rpc/http/getaccountinfo)
- Versioned transactions: legacy and v0 have a 1,232-byte limit (v0 supports ALTs); V1 has a 4,096-byte limit, removes ALTs (all accounts in the message), and sets priority fee as an absolute lamport total in the message config; limits 64 accounts, 96 for V1 under SIMD-0596. [V] — [Solana docs: versions](https://solana.com/docs/core/transactions/versions); [Solana docs: transactions](https://solana.com/docs/core/transactions); [fees](https://solana.com/docs/core/fees)
- RPC: if `maxSupportedTransactionVersion` is unset, only legacy transactions are returned and v0 transactions cause an error; set it to the integer `1` to cover all formats (current docs). [V] — [Solana docs: versions](https://solana.com/docs/core/transactions/versions); [getTransaction](https://solana.com/docs/rpc/http/gettransaction)
- ALT resolution: validators append resolved keys to the static keys; final order = static keys, then ALT-loaded writable, then ALT-loaded readonly; an ALT holds up to 256 keys; fee payer and signers must be static; only non-signers load from ALTs; it does not say whether program ids can be loaded from an ALT (the rules do not exclude it). [V] — [Solana docs: versioned transactions](https://solana.com/docs/core/transactions/versioned-transactions)
- `meta.loadedAddresses` returns the ordered `writable` and `readonly` lists; `innerInstructions` (jsonParsed gives `program`, `programId`, `parsed`, `stackHeight`; json gives `accounts`, `data`, `programIdIndex`, `stackHeight`) can be null/omitted. [V] — [getTransaction](https://solana.com/docs/rpc/http/gettransaction)
- Fees: 5,000 lamports per signature; priority fee = `ceil(compute_unit_price * compute_unit_limit / 1,000,000)` lamports with price in micro-lamports per CU; default 200,000 CU per instruction (3,000 for builtins), maximum 1,400,000 per transaction. [V] — [Solana docs: fees](https://solana.com/docs/core/fees)
- pump.fun recommends a static CU limit such as 100,000 for buy/sell instead of simulating first. [V] — [pump FAQ](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/FAQ.md)
- Jito: a tip is a SOL transfer (instruction or CPI) to one of 8 tip accounts (`getTipAccounts` at `https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts`); minimum 1000 lamports; bundles up to 5 transactions, atomic, within one slot; tip must be inside the bundle; tip accounts should not be loaded through ALTs; tips don't prioritize when the leader isn't a Jito validator; suggested 70/30 priority-fee/tip split for `sendTransaction`. [V] — [Jito low-latency txn send docs](https://docs.jito.wtf/lowlatencytxnsend/)

### Inferences
- Classifying an `owner`: fetch `getAccountInfo(owner)`; (a) system-program-owned (or null/non-existent account that has signed) and on the ed25519 curve = normal wallet; (b) owned by a non-system program, or off-curve = PDA/program-controlled (pool vault authorities, bonding-curve accounts, escrow, vesting, Squads vaults, burn addresses). Note: a wallet can also be a smart wallet whose address is a PDA, so (b) should be labelled "program-controlled", not "insider". [I]. Raydium AMM v4 vault authority, pump bonding-curve ATA and Mayhem token vault are all examples of non-wallet "holders". [I]
- Which programs a transaction really called: build the full key list = `message.accountKeys` + `meta.loadedAddresses.writable` + `.readonly`; then for each top-level instruction take `programIdIndex` into that list; then flatten `meta.innerInstructions` (each has parent `index` and `stackHeight`); a swap through Jupiter shows one top-level Jupiter instruction and the real DEX program as inner instructions. Filter ComputeBudget, system transfers to Jito tip accounts, memo and ATA-create instructions as non-trade. [I]
- Keep the tip transfer out of the P&L: a tip is a SystemProgram transfer to a known tip account (find in static keys, since tips avoid ALTs). [I]
- V1 transactions have no ALTs; decoders written for legacy/v0 can mis-handle `version = 1` if they assume lookup tables. [I]
- ComputeBudget program id and instruction layouts (`SetComputeUnitLimit`, `SetComputeUnitPrice`) are not printed on pages I read; the fees page names the variants only. [I]

### Gaps
- Exact tip account list and ComputeBudget program id not retrieved.
- Practical rate of v1 transactions on mainnet in Oct 2026: not found.
- Whether the on-curve test is documented in a Solana page I read: not found (rule above is general knowledge).

---

## 7. Launchpad-specific supply/holder distortions (pump.fun create_v2, Mayhem Mode)

### Takeaway
pump.fun `create_v2` mints are Token-2022 with a metadata pointer on the mint and a Pump-PDA mint authority; Mayhem Mode (opt-in, tied to `create_v2`) mints supply of 2 billion rather than 1 billion, with the extra tokens held by an agent for 24 hours and any unsold balance burned, so total supply, circulating supply and top-holder percentages are misleading unless the agent vault and the curve account are excluded.

### Cited Findings
- `create_v2` uses Token-2022 (`TokenzQd…`) as token program, decimals 6, mint authority = Pump PDA seeds `[b"mint-authority"]`; the doc does not mention a freeze authority; arguments include `is_mayhem_mode` (bool) and accounts `mayhem_program_id`, `global_params`, `sol_vault`, `mayhem_state`, `mayhem_token_vault`. [V] — [pump COIN_CREATION](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/instructions/COIN_CREATION.md)
- Bonding curve account has `is_mayhem_mode` ("whether the coin is a mayhem coin"), `token_total_supply` raw `1000000000000000` in `Global` and per-curve, `real_token_reserves` (decreases with buys), `complete` (set true when `real_token_reserves == 0` at the end of a buy), `creator` (older accounts read `Pubkey::default()`). [V] — [pump PUMP_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md)
- Mayhem supply: Chainstack says Mayhem tokens launch with 2 billion tokens (double the standard 1 billion); mode is tied to `create_v2` (Token-2022) while legacy `create` uses the original token program with Metaplex metadata; the bonding-curve token account is owned by Token-2022 so user ATAs must be derived with the Token-2022 program id; Mayhem coins need different fee recipients or transactions fail. An agent trades randomly during the first 24 hours; unsold agent tokens are burned afterward. [V][S] — [Chainstack](https://chainstack.com/trading-bot-update-full-mayhem-mode-support-for-pump-fun/)
- The Block (via search snippet): Mayhem Mode is opt-in at creation, not available for existing or graduated coins; 1 billion additional tokens minted; agent has caps on trade size/frequency and pays no protocol fees; launches averaged 17,300/day before and 17,800/day after. [S, secondary] — [The Block](https://www.theblock.co/post/379285/pump-funs-new-mayhem-mode-fails-boost-token-launches-revenue)
- Helius: launchpads like Pump.fun and LetsBonk set mint authority to null so creators cannot mint more; revoking Metaplex update authority is the default for new pump.fun tokens. [V][S] — [Helius Orb](https://www.helius.dev/docs/orb/explore-authorities). Conflict: the pump `create_v2` doc says the mint authority is initialised to a Pump PDA and does not say it is later revoked. The two are not reconciled by any source I read.
- Legacy `create` and `create_v2` coexist (legacy "expected to be deprecated"), so decoders must handle both token programs. [V][S] — [Chainstack](https://chainstack.com/trading-bot-update-full-mayhem-mode-support-for-pump-fun/)
- Pump docs list further concept files (HOLDER_REWARDS, SYNTHETIC_MIGRATION, NEGATIVE_VIRTUAL_QUOTE_RESERVES, VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT, creator fee sharing, quote-coin create) that affect price/supply maths; I did not read them. [V (listing)] — [pump-public-docs README](https://github.com/pump-fun/pump-public-docs)

### Inferences
- With `token_total_supply = 1e15` raw and 6 decimals the standard curve supply is 1,000,000,000 tokens; mayhem coins report a larger mint supply (2B) per Chainstack, so any % holder calculation must use the curve/pool's own initial supply or exclude `mayhem_token_vault` and the bonding curve's token account from both numerator and denominator. [I]
- Treat as non-holders (exclude from concentration, "unique holders" and insider-share): the bonding curve's token account, the `mayhem_token_vault`, pump AMM pool vaults after migration, burn addresses; the supply used for percentages should be `supply - burned - curve_reserves - agent_vault`. [I]
- Mayhem agent buys/sells inflate volume, trade counts and unique-wallet counts for 24 hours, and its token vault balance shrinking to zero at the 24-hour burn lowers `getTokenSupply`; do not read a supply drop as a creator burn or a sale. [I]
- A guard: parse `is_mayhem_mode` from the bonding curve / create event and use a separate holder/volume baseline for such coins. [I]

### Gaps
- Pump docs fetched do not describe Mayhem supply amounts, who the agent holder is, or whether the 1B extra tokens sit in `mayhem_token_vault`; the vault location is an inference from the account name.
- Mint authority and freeze authority state of live `create_v2` mints (revoked or still Pump PDA) not checked on-chain.
- Which Token-2022 extensions `create_v2` mints carry beyond the metadata pointer: the doc names none, so confirm by parsing a live mint.
- Other launchpads (LetsBonk/Raydium Launchlab, Meteora DBC) token features were only touched via a search result mentioning DBC transfer-hook pools (single community issue, not opened).
