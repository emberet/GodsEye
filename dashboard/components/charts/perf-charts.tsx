"use client";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, LabelList } from "recharts";
import type { Performance } from "@/lib/types";

const WIN = "#D4EC00";
const LOSS = "#FF7B7B";
const tooltipStyle = { background: "#24242B", border: "3px solid #0B0B0C", borderRadius: 14, boxShadow: "4px 4px 0 #0B0B0C", color: "#FFFBE6", fontFamily: "var(--font-sans)", fontSize: 12 };
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
        <ReferenceLine y={data.startingCapitalUsd} stroke="#5A5A66" strokeDasharray="4 4" />
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
        <ReferenceLine y={50} stroke="#5A5A66" strokeDasharray="4 4" />
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
        <ReferenceLine y={0} stroke="#5A5A66" />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, _n, p) => [`${v.toFixed(2)}% ($${(p.payload as { pnlSol: number }).pnlSol.toFixed(2)})`, "return"]} />
        <Bar dataKey="returnPct" isAnimationActive={false}>
          {data.monthly.map((m) => (
            <Cell key={m.month} fill={m.returnPct >= 0 ? WIN : LOSS} />
          ))}
          {/* The number on each bar, so gain vs loss doesn't rest on colour alone. */}
          <LabelList dataKey="returnPct" position="top" fill="#FFFBE6" fontSize={11} formatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
