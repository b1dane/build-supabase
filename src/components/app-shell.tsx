"use client";

import { useState } from "react";
import Dashboard from "@/components/dashboard";
import Btc15mPaperSimulator from "@/components/btc15m-paper-simulator";

export default function Home() {
  const [tab, setTab] = useState<"stage2" | "stage1">("stage2");

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(217,70,239,0.12),transparent)]" />
      <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-400 to-purple-600 font-black text-slate-950">◈</div>
            <div>
              <p className="text-[11px] font-bold tracking-[0.2em] text-fuchsia-300/80">PULSE · KALSHI BTC 15M</p>
              <h1 className="text-xl font-bold leading-tight sm:text-2xl">Paper-trading simulator</h1>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-fuchsia-300/30 bg-fuchsia-400/10 px-3 py-1 text-[11px] font-bold tracking-wide text-fuchsia-200">PAPER / SIMULATED ONLY</span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-bold tracking-wide text-emerald-200">NO LIVE TRADING</span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-slate-300">BTC · Up/Down · 15m</span>
          </div>
        </header>

        <nav className="mt-4 flex gap-2">
          {([
            ["stage2", "Stage 2 · Paper simulator (BTC 15m Up/Down)"],
            ["stage1", "Stage 1 · Read-only table monitor"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-xl px-4 py-2 text-[13px] font-bold transition ${
                tab === k ? "bg-white text-slate-950" : "border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-4">
          {tab === "stage2" ? <Btc15mPaperSimulator /> : <Dashboard />}
        </div>

        <footer className="mt-6 text-center text-[11px] leading-relaxed text-slate-600">
          Read-only Kalshi market data · paper simulation only · no order-placement APIs · no broker credentials.<br />
          Paper data is isolated from daily_balances, trades, bot_logs, and kalshi_trades. Supabase secrets belong only in the platform secret manager.
        </footer>
      </div>
    </div>
  );
}
