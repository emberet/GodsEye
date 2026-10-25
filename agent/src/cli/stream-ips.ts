/**
 * `npm run stream:ips` — which of this connection's public IPs come up most, so the gRPC allowlist's few
 * slots go to the best ones. Counts the minutes Shyft turned each IP away over the last 7 days (from
 * stream_ip_seen, and the older log lines from before it existed). IPs already allowlisted never show up:
 * Shyft lets those in.
 */
import { openDb } from "@godseye/shared";

const DAYS = 7;
const db = openDb();
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

const minutes = new Map<string, number>();
const add = (ip: string, n: number) => minutes.set(ip, (minutes.get(ip) ?? 0) + n);

const table = db.prepare("SELECT ip, minutes FROM stream_ip_seen WHERE last_seen >= ?").all(since) as { ip: string; minutes: number }[];
for (const r of table) add(r.ip, r.minutes);

// Before the table existed, every rejection was logged: count those minutes too.
const tableStart = (db.prepare("SELECT MIN(first_seen) t FROM stream_ip_seen").get() as { t: string | null }).t ?? new Date().toISOString();
const logged = db
  .prepare(
    `SELECT substr(message, instr(message, 'client IP ') + 10, instr(message, ' is not whitelisted') - instr(message, 'client IP ') - 10) ip,
       COUNT(DISTINCT substr(ts, 1, 16)) n
     FROM agent_log WHERE message LIKE '%is not whitelisted%' AND ts >= ? AND ts < ? GROUP BY ip`,
  )
  .all(since, tableStart) as { ip: string; n: number }[];
for (const r of logged) if (r.ip) add(r.ip, r.n);

const ranked = [...minutes.entries()].sort((a, b) => b[1] - a[1]);
const total = ranked.reduce((s, [, n]) => s + n, 0);
if (!total) {
  console.log(`No rejected IPs in the last ${DAYS} days.`);
  process.exit(0);
}
const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

console.log(`Public IPs Shyft turned away, last ${DAYS} days (${ranked.length} different IPs, ${total} minutes):\n`);
for (const [ip, n] of ranked.slice(0, 15)) console.log(`  ${ip.padEnd(17)} ${String(n).padStart(5)} min  ${pct(n).padStart(6)}`);
const top3 = ranked.slice(0, 3).reduce((s, [, n]) => s + n, 0);
console.log(`\nAllowlisting the top 3 would have covered ${pct(top3)} of the time spent waiting.`);
