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
