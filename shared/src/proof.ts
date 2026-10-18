/**
 * PROOF LEDGER — the "we can't cheat" layer.
 * Before GodsEye executes anything (trade, launch, airdrop) it writes the
 * decision down and stores a SHA-256 fingerprint of it. Each fingerprint
 * also includes the previous one, forming a chain. Anyone can recompute:
 *     hash = sha256(prev_hash + "|" + payload)
 * If any old entry were edited, its hash — and every hash after it — would
 * stop matching.
 */
import { createHash } from "node:crypto";
import { PROOF_GENESIS_HASH } from "./constants";
import { type DB, nowIso } from "./db";

/** JSON with keys sorted, so the same data always produces the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const chainHash = (prevHash: string, payload: string): string => sha256Hex(`${prevHash}|${payload}`);

export interface ProofEntry {
  id: number;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
  committed_at: string;
}

/** Commit a decision to the ledger. Call this BEFORE executing it. */
export function commitProof(db: DB, kind: string, data: Record<string, unknown>): ProofEntry {
  const tx = db.transaction(() => {
    const last = db.prepare("SELECT hash FROM proof_ledger ORDER BY id DESC LIMIT 1").get() as
      | { hash: string }
      | undefined;
    const prevHash = last?.hash ?? PROOF_GENESIS_HASH;
    const committedAt = nowIso();
    const payload = canonicalJson({ kind, committed_at: committedAt, ...data });
    const hash = chainHash(prevHash, payload);
    const info = db
      .prepare("INSERT INTO proof_ledger (kind, payload, prev_hash, hash, committed_at) VALUES (?, ?, ?, ?, ?)")
      .run(kind, payload, prevHash, hash, committedAt);
    return { id: Number(info.lastInsertRowid), kind, payload, prev_hash: prevHash, hash, committed_at: committedAt };
  });
  return tx();
}

/** Re-checks the whole chain. Returns the first broken entry, if any. */
export function verifyProofChain(entries: ProofEntry[]): { ok: boolean; checked: number; brokenAtId?: number } {
  let prev = PROOF_GENESIS_HASH;
  for (const e of entries) {
    if (e.prev_hash !== prev || chainHash(e.prev_hash, e.payload) !== e.hash) {
      return { ok: false, checked: entries.length, brokenAtId: e.id };
    }
    prev = e.hash;
  }
  return { ok: true, checked: entries.length };
}
