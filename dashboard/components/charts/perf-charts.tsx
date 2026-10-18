"use client";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Performance } from "@/lib/types";

const WIN = "#00FF88";
const LOSS = "#FF4444";
const tooltipStyle = { background: "#050707", border: "1px solid #24302f", fontFamily: "var(--font-mono)", fontSize: 12 };
const day = (iso: string) => iso.slice(5, 10);

export function EquityChart({ data }: { data: Performance }) {
  const up = (data.equity.at(-1)?.equity ?? data.startingCapitalUsd) >= data.startingCapitalUsd;
  const color = up ? WIN : LOSS;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data.equity} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="ts" tickFormatter={day} minTickGap={40} />
        <YAxis domain={["auto", "auto"]} width={56} tickFormatter={(v: number) => v.toFixed(1)} />
        <ReferenceLine y={data.startingCapitalUsd} stroke="#55615f" strokeDasharray="4 4" />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(l: string) => l.replace("T", " ").slice(0, 16)} formatter={(v: number) => [`$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`, "equity"]} />
        <Area type="stepAfter" dataKey="equity" stroke={color} strokeWidth={2} fill="url(#eq)" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function RollingWinRateChart({ data }: { data: Performance }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data.rollingWinRate} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} minTickGap={30} />
        <YAxis domain={[0, 100]} width={40} tickFormatter={(v: number) => `${v}%`} />
        <ReferenceLine y={50} stroke="#55615f" strokeDasharray="4 4" />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, _n, p) => [`${v.toFixed(1)}% (${(p.payload as { trades: number }).trades} trades)`, "30d win rate"]} />
        <Line type="monotone" dataKey="winRate" stroke={WIN} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MonthlyChart({ data }: { data: Performance }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data.monthly} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="month" />
        <YAxis width={48} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
        <ReferenceLine y={0} stroke="#55615f" />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, _n, p) => [`${v.toFixed(2)}% ($${(p.payload as { pnlSol: number }).pnlSol.toFixed(2)})`, "return"]} />
        <Bar dataKey="returnPct" isAnimationActive={false}>
          {data.monthly.map((m) => (
            <Cell key={m.month} fill={m.returnPct >= 0 ? WIN : LOSS} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
