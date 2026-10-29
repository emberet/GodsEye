import { Connection } from "@solana/web3.js";
import { copyRpcUrl, copyWsUrl, rpcUrl, wsUrl } from "./config";

let conn: Connection | null = null;
/** The main RPC: wallet history reads (analysis, discovery). */
export function connection(): Connection {
  if (!conn) conn = new Connection(rpcUrl(), { commitment: "confirmed", wsEndpoint: wsUrl() });
  return conn;
}

let copyConn: Connection | null = null;
/** The copy path's RPC (COPY_RPC_URL): leader transactions, the agent wallet, sending and confirming trades. */
export function copyConnection(): Connection {
  if (!copyConn) copyConn = new Connection(copyRpcUrl(), { commitment: "confirmed", wsEndpoint: copyWsUrl() });
  return copyConn;
}
