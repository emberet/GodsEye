/**
 * Sends a signed transaction through Jito's block engine (its sendTransaction, the same call as an RPC's). A trade sent
 * this way goes to the validators that run Jito, not into the public queue, so it is harder to sandwich. It pays a tip
 * (added by Jupiter, checked by verify.ts) in place of a priority fee.
 *
 * Without a key Jito allows about one send a second from one address. A refusal is not an error for the trade: the
 * caller falls back to its RPC. Nothing here logs: a failed send says only that it failed (no signature, no body).
 */
import { config } from "../config";
import { fetchJson } from "../http";

export async function jitoSend(raw: Uint8Array): Promise<void> {
  const res = await fetchJson<{ result?: string; error?: unknown }>(`${config.jitoUrl.replace(/\/+$/, "")}/api/v1/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64" }] }),
    retries: 0,
    timeoutMs: 4_000,
  });
  if (res.error || typeof res.result !== "string") throw new Error("Jito did not take the transaction");
}
