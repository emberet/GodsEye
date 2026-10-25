export const sol = (n: number | null | undefined, d = 4) => (n === null || n === undefined ? "—" : `${n.toFixed(d)}`);
export const signedSol = (n: number | null | undefined, d = 4) =>
  n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
export const pct = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);
export const usd = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(4)}`;
};
export const lamportsToSol = (l: number) => l / 1_000_000_000;
export const shortAddr = (a: string | null | undefined, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : "—");
export const dt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
export const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const pnlClass = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? "text-muted-foreground" : n > 0 ? "text-lime" : "text-loss");
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (a: string) => `https://solscan.io/account/${a}`;
/** Signed dollars: +$1,234 / −$56.78 (cents shown under $100). */
export const signedUsd = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const body = abs.toLocaleString("en-US", { minimumFractionDigits: abs < 100 ? 2 : 0, maximumFractionDigits: abs < 100 ? 2 : 0 });
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}$${body}`;
};
/** Plain dollars: $1,234 / $56.78. */
export const dollars = (n: number | null | undefined) => (n === null || n === undefined ? "—" : signedUsd(Math.abs(n)).replace(/^[+−]/, ""));
/**
 * How much history a wallet's numbers really cover. GodsEye reads a wallet's latest transactions (then
 * everything newer), so a busy trader's "30-day" figures may only reach back a day or two.
 *   "30 days" · "since 17 Oct" · "last 6h"
 */
export const spanLabel = (from: string | null | undefined, now = Date.now()) => {
  if (!from) return "30 days";
  const ms = now - Date.parse(from);
  if (ms >= 30 * 86_400_000) return "30 days";
  if (ms >= 86_400_000) return `since ${new Date(from).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
  return `last ${Math.max(1, Math.round(ms / 3_600_000))}h`;
};
/** True when a wallet's history reaches back a full week, so its 7-day figure means 7 days. */
export const hasWeek = (from: string | null | undefined, now = Date.now()) => !from || now - Date.parse(from) >= 7 * 86_400_000;
/** Label for a wallet's 7-day profit: "7d", or the shorter span it actually covers. */
export const weekLabel = (from: string | null | undefined, now = Date.now()) => (hasWeek(from, now) ? "7d" : spanLabel(from, now));
/** A coin's chart on DexScreener. */
export const dexscreenerToken = (mint: string) => `https://dexscreener.com/solana/${mint}`;

/** Plain words for the live stream's status (the meta value the agent writes). */
export const streamStatusLabel = (status: string | null | undefined) =>
  status === "connected" ? "Connected" : status === "waiting_for_ip" ? "Waiting for an allowlisted IP" : status === "reconnecting" ? "Reconnecting" : status ?? "Starting";
