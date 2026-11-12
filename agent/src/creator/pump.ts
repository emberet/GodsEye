/**
 * pump.fun for the creator-rewards job (./rewards.ts): reads and instructions from pump.fun's official SDK
 * (@pump-fun/pump-sdk, pinned), loaded only when the job is switched on, and the sender that builds, checks, simulates
 * and only then signs. Nothing here logs an address or a signature; errors say what failed, not with which keys.
 */
import { type Connection, type Keypair, PublicKey, TransactionMessage, type TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { SOL_MINT } from "@godseye/shared";
import { noteCopyRpc } from "../chain/rpc-budget";
import { withTimeout } from "../jobs";
import type { PumpClient, RewardsSender } from "./rewards";

const READ_MS = 20_000;
const NATIVE_MINT = new PublicKey(SOL_MINT);
type Sdk = typeof import("@pump-fun/pump-sdk");
let sdk: Promise<Sdk> | null = null;
const loadSdk = (): Promise<Sdk> => (sdk ??= import("@pump-fun/pump-sdk"));

const big = (bn: { toString(): string }): bigint => BigInt(bn.toString());

export async function pumpClient(conn: Connection): Promise<PumpClient> {
  const s = await loadSdk();
  const online = new s.OnlinePumpSdk(conn);
  const read = <T>(p: Promise<T>, what: string): Promise<T> => {
    noteCopyRpc();
    return withTimeout(p, READ_MS, what);
  };
  return {
    async creatorVaultLamports(creator) {
      return big(await read(online.getCreatorVaultBalanceBothPrograms(creator), "creator vault"));
    },
    async sharingConfig(mint) {
      const info = await read(conn.getAccountInfo(s.feeSharingConfigPda(mint)), "fee-sharing config");
      if (!info) return null;
      const config = s.PUMP_SDK.decodeSharingConfig(info);
      return {
        shareholders: config.shareholders.map((h) => ({ address: h.address.toBase58(), shareBps: h.shareBps })),
        editable: s.isSharingConfigEditable({ sharingConfig: config }),
      };
    },
    async distributable(mint) {
      // pump.fun's own view, simulated with the SDK's default funded signer (the agent's wallet may hold nothing yet).
      const r = await read(online.getMinimumDistributableFee(mint), "distributable fees");
      return { lamports: big(r.distributableFees), can: r.canDistribute };
    },
    async distributeInstructions(mint, payer) {
      return (await read(online.buildDistributeCreatorFeesInstructions(mint, { payer }), "distribute instructions")).instructions;
    },
    async collectInstructions(creator, mint) {
      const sweeps: TransactionInstruction[] = [];
      // Fees the coin's newer trades leave on its curve reach the vault only through a sweep (anyone may run one).
      const curve = mint ? await read(online.fetchBondingCurve(mint), "bonding curve").catch(() => null) : null;
      if (mint && curve?.creator.equals(creator) && !curve.creatorFee.isZero()) {
        sweeps.push(await s.PUMP_SDK.sweepCreatorFeeInstruction({ payer: creator, mint, creator, quoteMint: NATIVE_MINT }));
      }
      return [...sweeps, ...(await read(online.collectCoinCreatorFeeInstructions(creator, creator), "collect instructions"))];
    },
  };
}

/**
 * The instructions that set the coin's split once (pump.fun locks it after): a sharing config if there is none yet,
 * then the shares. Two steps, because the second needs the config's current shareholders.
 */
export async function splitInstructions(conn: Connection, creator: PublicKey, mint: PublicKey, shares: { address: PublicKey; shareBps: number }[]) {
  const s = await loadSdk();
  const online = new s.OnlinePumpSdk(conn);
  const curve = await withTimeout(online.fetchBondingCurve(mint), READ_MS, "bonding curve");
  if (!curve.creator.equals(creator)) throw new Error("the agent's wallet is not this coin's creator");
  const sweep = curve.creatorFee.isZero() ? [] : [await s.PUMP_SDK.sweepCreatorFeeInstruction({ payer: creator, mint, creator, quoteMint: NATIVE_MINT })];
  const configAddress = s.feeSharingConfigPda(mint);
  const pool = curve.complete ? s.canonicalPumpPoolPda(mint) : null;
  const create = async () => [...sweep, await s.PUMP_SDK.createFeeSharingConfig({ creator, mint, pool })];
  const update = async () => {
    const info = await withTimeout(conn.getAccountInfo(configAddress), READ_MS, "fee-sharing config");
    if (!info) throw new Error("the coin has no fee-sharing config yet");
    const config = s.PUMP_SDK.decodeSharingConfig(info);
    if (!s.isSharingConfigEditable({ sharingConfig: config })) throw new Error("the coin's split is already set and locked");
    return [
      ...sweep,
      await s.PUMP_SDK.updateFeeShares({
        authority: creator,
        mint,
        currentShareholders: config.shareholders.map((h) => h.address),
        newShareholders: shares,
        bondingCurveComplete: curve.complete,
      }),
    ];
  };
  const exists = !!(await withTimeout(conn.getAccountInfo(configAddress), READ_MS, "fee-sharing config"));
  return { exists, create, update };
}

/** Builds the transaction, runs `check`, simulates it and compares the wallet's SOL; then, unless dry, signs and sends. */
export function walletSender(conn: Connection, wallet: PublicKey, keypair: Keypair | null): RewardsSender {
  return {
    async run(ixs, check, minGainLamports, dry) {
      noteCopyRpc();
      const { blockhash, lastValidBlockHeight } = await withTimeout(conn.getLatestBlockhash("confirmed"), READ_MS, "blockhash");
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
      const why = check(tx);
      if (why) throw new Error(`creator rewards refused before signing: ${why}`);
      noteCopyRpc(2);
      const pre = BigInt(await withTimeout(conn.getBalance(wallet, "processed"), READ_MS, "wallet balance"));
      const sim = await withTimeout(
        conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses: [wallet.toBase58()] } }),
        READ_MS,
        "simulation",
      );
      if (sim.value.err) throw new Error(`creator rewards: the simulation failed (${JSON.stringify(sim.value.err)})`);
      const after = sim.value.accounts?.[0];
      if (!after) throw new Error("creator rewards: the simulation returned no wallet state");
      const gain = BigInt(after.lamports) - pre;
      if (gain < minGainLamports) throw new Error(`creator rewards refused: the simulation moves the agent's SOL by ${Number(gain) / 1e9}, expected at least ${Number(minGainLamports) / 1e9}`);
      if (dry) return null;
      if (!keypair) throw new Error("creator rewards: no key to sign with");
      tx.sign([keypair]);
      noteCopyRpc(2);
      const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`creator rewards: the transaction failed on-chain (${JSON.stringify(conf.value.err)})`);
      return { signature, slot: conf.context.slot };
    },
  };
}
