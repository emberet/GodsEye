import type { Metadata } from "next";
import Link from "next/link";
import { Eye, LineChart, ListChecks, LogOut, Repeat, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "How it works", description: "How GodsEye picks wallets, copies their trades, keeps its money safe and learns, in plain words, with a short glossary." };

const STEPS = [
  { icon: Eye, tile: "bg-lime", title: "Watch", text: "It reads every memecoin trade on Solana as it happens, and remembers which wallets bought what, when, and how it went." },
  { icon: LineChart, tile: "bg-lilac", title: "Study", text: "Each wallet that keeps making money gets a full check: how long its record is, whether it is a bot or a person, and whether its wins look like luck or a pattern." },
  { icon: ListChecks, tile: "bg-sun", title: "Choose", text: "Only wallets with a real track record are copied. Each one gets a share of the budget that grows when copying it pays and shrinks when it doesn't." },
  { icon: Repeat, tile: "bg-coral", title: "Copy", text: "When a chosen wallet buys, GodsEye checks the coin and the price it would get, then buys a small amount within seconds." },
  { icon: LogOut, tile: "bg-lime", title: "Exit", text: "It sells when the wallet it copied sells, or earlier on its own stops: a loss limit, a profit target, or a trade held too long." },
  { icon: ShieldCheck, tile: "bg-lilac", title: "Learn", text: "Every closed trade feeds back in: which wallets to back, how much to put in, when to sell. The Brain learns the same things from millions of past trades." },
] as const;

const SAFETY = [
  ["Coin checks first", "A coin is skipped when its creator can still freeze it, mint more of it, or take a large cut on every transfer, or when the check service can't be reached."],
  ["Checked before signing", "Every trade is simulated first. If it would spend more than planned or touch anything else in the wallet, it isn't sent."],
  ["Limits it can't break", "The owner sets outer limits: how much of the wallet one trade may use, a daily stop, and a self-pause after a deep fall. The agent sizes trades inside them."],
  ["Deposits aren't profit", "Money put in or taken out is booked apart, like units in a fund, so it never looks like a win or a loss."],
  ["A public record", "Every trade is written to a proof ledger where each entry carries the fingerprint of the one before, so the history can't be edited quietly."],
] as const;

const GLOSSARY: [string, string][] = [
  ["Memecoin", "A coin with no business behind it, traded on hype. Most lose nearly all their value within days."],
  ["Wallet", "An account on Solana. Anyone can see what any wallet holds and trades."],
  ["Leader", "A wallet GodsEye copies."],
  ["Copy trade", "A trade GodsEye makes because a leader made the same one moments earlier."],
  ["Paper trade", "A pretend trade at real prices, with no real money: used for practice and comparison."],
  ["SOL", "Solana's own coin. GodsEye's trades and fees are paid in it."],
  ["Slippage", "The gap between the price you expect and the price you get. Busy coins move while a trade is on its way."],
  ["Fees", "What every trade costs: the network's fee, a tip so the trade lands quickly, and the coin market's own cut. Results here are after all of them."],
  ["Rug pull", "When a coin's makers take the money and run, leaving holders with a worthless coin."],
  ["Launchpad", "A site where anyone can start a coin in a minute. Its price follows a fixed curve until enough is bought, then it moves to an open market."],
  ["Sandwich", "A trick where a bot buys just before your trade and sells just after, so you pay more. GodsEye sends its trades privately and caps the price it accepts."],
  ["Smart money", "Wallets whose buys have tended to come before the price rose."],
  ["Signal", "Three or more smart wallets buying, or dumping, the same coin within an hour."],
  ["Runner", "A coin that rose five times or more and stayed up for a while."],
  ["Early-entry pattern", "A wallet that often buys a coin within moments of its launch. A pattern in public data, not an accusation."],
  ["Bot score", "How much a wallet trades like a program rather than a person: speed, timing and regularity."],
  ["To trade with", "What GodsEye's wallet is worth for trading: its SOL plus open trades at a careful price, less a small reserve for fees."],
  ["Drawdown", "How far the account has fallen from its best point."],
  ["Daily stop", "After a set fall in one day, GodsEye makes no new buys until the next day. Sells keep running."],
  ["Self-pause", "After a deep fall from its best point, GodsEye stops buying until the owner restarts it."],
  ["Brain", "GodsEye's neural network. It practises on paper and may decide a share of real copies once it passes a safety check."],
  ["Baseline", "Today's copying rules run on paper next to the Brain, on the same signals, so the two can be compared fairly."],
  ["Explore", "A small paper account where the Brain tries things it wouldn't normally do, to learn from them."],
];

export default function HowPage() {
  return (
    <>
      <PageHeader title="How it works" kicker="What GodsEye does with every trade, in plain words." />

      <section className="card">
        <p className="text-lg font-bold leading-snug">
          GodsEye is an agent that watches Solana&apos;s memecoin traders, finds the wallets that keep making money, and copies their trades
          with a small amount each time. It keeps a public record of every trade and learns from each one.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Memecoins are extremely risky. Most copies lose, and a wallet&apos;s past profit says nothing certain about its next trade. Nothing here is
          financial advice.
        </p>
      </section>

      <section aria-label="Steps" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className={`tile ${s.tile} min-w-0 text-ink`}>
            <div className="flex items-center gap-2">
              <s.icon size={18} strokeWidth={2.6} aria-hidden />
              <p className="text-sm font-extrabold">
                {i + 1}. {s.title}
              </p>
            </div>
            <p className="mt-2 text-sm font-medium text-ink/80">{s.text}</p>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="text-xl font-extrabold tracking-[-0.02em]">How it keeps its money safe</h2>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          {SAFETY.map(([t, d]) => (
            <div key={t} className="min-w-0">
              <dt className="font-extrabold">{t}</dt>
              <dd className="mt-0.5 text-sm text-muted-foreground">{d}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm">
          See it for yourself: <Link href="/copies" className="font-bold text-accent underline-offset-2 hover:underline">every trade</Link>,{" "}
          <Link href="/performance" className="font-bold text-accent underline-offset-2 hover:underline">results over time</Link>,{" "}
          <Link href="/proof" className="font-bold text-accent underline-offset-2 hover:underline">the proof ledger</Link> and{" "}
          <Link href="/brain" className="font-bold text-accent underline-offset-2 hover:underline">the Brain</Link>.
        </p>
      </section>

      <section className="card">
        <h2 className="text-xl font-extrabold tracking-[-0.02em]">Glossary</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-3 md:grid-cols-2">
          {GLOSSARY.map(([t, d]) => (
            <div key={t} id={t.toLowerCase().replace(/[^a-z]+/g, "-")} className="min-w-0 border-t-2 border-ink/70 pt-2">
              <dt className="font-extrabold">{t}</dt>
              <dd className="mt-0.5 text-sm text-muted-foreground">{d}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
