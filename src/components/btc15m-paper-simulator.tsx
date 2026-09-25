"use client";

import { useCallback, useEffect, useState } from "react";
import type { MarketVerificationResult } from "@/lib/kalshi-btc15m-verifier";

type Row = Record<string, unknown>;

type Portfolio = {
  label: string;
  startingPaperBalanceDollars: number | null;
  availablePaperCashDollars: number | null;
  openExposureDollars: number;
  cumulativeStakedDollars: number;
  realizedPnlDollars: number;
  pnlPctOfStartingBalance: number | null;
  totalFeesAssumedDollars: number;
  todayTradeCount: number;
  totalOrdersCount: number;
  settledOrdersCount: number;
  unsettledOrdersCount: number;
  rules: {
    firstBetCapDollars: number | null;
    progressionGatePct: number | null;
    hardStopPct: number | null;
    earlyCashOutAllowed: boolean | null;
    negativeBalanceAllowed: boolean;
    nextTradeUnlocked: boolean;
    hardStopReached: boolean;
    blocker: string | null;
  };
};

type Order = {
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  contracts: number;
  effectiveFillCents: number;
  totalStakeDollars: number;
  settlementStatus: string;
  officialResult: string | null;
  officialExpirationValue: string | null;
  realizedPnlDollars: number | null;
  settlementExplanation: string;
  intervalOpenTime: string;
  intervalCloseTime: string;
};

type RunState = {
  runId: string;
  status: "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";
  hardStopTriggered: boolean;
  stoppedReason: string | null;
} | null;

type Config = {
  strategyName: string;
  strategyRule: string;
  startingPaperBalanceDollars: number;
  limits: {
    maxStakeFirstTradeDollars: number;
    maxStakeDollars: number;
    maxDailyTrades: number;
    maxTotalExposureDollars: number;
    progressionGatePct: number;
    hardStopPct: number;
    allowEarlyCashOut: boolean;
  };
  assumptions: { feeRateBps: number; slippageCentsPerContract: number; note: string };
} | null;

type VerifyResult = {
  allPassed: boolean;
  passedCount: number;
  totalCount: number;
  liveKalshiReachable: boolean;
  liveKalshiError: string | null;
  discoveredSeriesTickers: string[];
  discoveredVerifiedMarketsCount: number;
  results: Array<{ id: string; category: string; name: string; expected: string; actual: string; passed: boolean }>;
};

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const time = (v: string) => (v ? new Date(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—");

export default function Btc15mPaperSimulator() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [run, setRun] = useState<RunState>(null);
  const [config, setConfig] = useState<Config>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [markets, setMarkets] = useState<MarketVerificationResult[]>([]);
  const [excluded, setExcluded] = useState<Row[]>([]);
  const [discoveryInfo, setDiscoveryInfo] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [sql, setSql] = useState("");
  const [contracts, setContracts] = useState(10);

  // Config form — prefilled with the USER'S stated directives + the USER'S Jev strategy (editable, must be applied)
  const [form, setForm] = useState({
    strategyName: "Jev batched decision engine (typesafe.ai)",
    strategyRule:
      "One Jev call per market asks direction (up/down/pass), conviction (0-3) and should_trade (noul). Paper-trade iff should_trade > 0.5 AND direction != pass AND conviction >= max(1, minConviction) — level 0 is never traded (no signal); up -> PAPER YES, down -> PAPER NO. Size = max contracts the caps permit.",
    startingPaperBalanceDollars: 10,
    maxStakeFirstTradeDollars: 5,
    maxStakeDollars: 5,
    maxDailyTrades: 5,
    maxTotalExposureDollars: 100,
    progressionGatePct: 30,
    hardStopPct: 75,
    feeRateBps: 0,
    slippageCentsPerContract: 0,
    minConviction: 1,
  });

  // Jev engine state
  const [engine, setEngine] = useState<{ configured: boolean; apiHost: string; model: string } | null>(null);
  const [decisions, setDecisions] = useState<Array<{
    decisionId: string; createdAt: string; mode: string; ticker: string; direction: string; conviction: number; shouldTrade: boolean;
    reasoning: string; parseErrors: string[]; willTrade: boolean; side: string | null; sizedContracts: number | null;
    outcome: string; outcomeCode: string; outcomeMessage: string; orderId: string | null; latencyMs: number | null;
  }>>([]);
  const [dryRun, setDryRun] = useState<{ prompt: string; ticker: string; contextErrors: string[] } | null>(null);
  const [autoEval, setAutoEval] = useState(false);
  const [autoLast, setAutoLast] = useState<string>("");

  // Gate math helper: is +gate% reachable from a single first bet at ~50¢?
  const gateNeeds = (form.startingPaperBalanceDollars * form.progressionGatePct) / 100;
  const stopNeeds = (form.startingPaperBalanceDollars * form.hardStopPct) / 100;
  const firstWinAt50 = form.maxStakeFirstTradeDollars; // $5 at 50¢ = 10 contracts -> $10 payout -> +$5
  const gateReachable = firstWinAt50 >= gateNeeds;

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/paper/state", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setPortfolio(j.portfolio);
        setRun(j.run);
        setConfig(j.config);
        setOrders(j.orders ?? []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const loadMarkets = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/paper/markets", { cache: "no-store" });
      const j = await r.json();
      setMarkets(j.verifiedMarkets ?? []);
      setExcluded(j.excludedExamples ?? []);
      setDiscoveryInfo(
        j.fetchError
          ? `Kalshi read-only API error: ${j.fetchError}`
          : `Inspected ${j.totalSeriesInspected} series → ${j.inScopeSeriesTickers.length} in scope → ${j.verifiedMarkets.length} verified markets.`
      );
    } catch (e) {
      setDiscoveryInfo(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const loadEngine = useCallback(async () => {
    try {
      const r = await fetch("/api/paper/decide", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setEngine({ configured: Boolean(j.configured), apiHost: String(j.apiHost), model: String(j.model) });
        setDecisions(j.decisions ?? []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    loadMarkets();
    loadEngine();
  }, [refresh, loadMarkets, loadEngine]);

  const decide = useCallback(
    async (mode: "dry-run" | "evaluate" | "evaluate-and-trade", ticker?: string, auto = false) => {
      setBusy(true);
      try {
        const r = await fetch("/api/paper/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, ticker, auto }),
        });
        const j = await r.json();
        if (mode === "dry-run" && j.ok) {
          setDryRun({ prompt: j.prompt, ticker: j.market.ticker, contextErrors: j.contextErrors ?? [] });
          return j;
        }
        if (j.decisions) setDecisions(j.decisions);
        if (j.portfolio) setPortfolio(j.portfolio);
        if (j.orders) setOrders(j.orders);
        if (j.run !== undefined) setRun(j.run);
        if (j.skipped) return j;
        if (!j.ok) {
          setFlash({ kind: "err", text: `${j.code}: ${j.message}` });
          if (j.prompt) setDryRun({ prompt: j.prompt, ticker: j.decision?.ticker ?? "", contextErrors: [] });
        } else {
          const d = j.decision;
          setFlash({
            kind: d.outcome === "PAPER_ORDER_RECORDED" ? "ok" : "err",
            text: `Jev on ${d.ticker}: ${d.direction.toUpperCase()} conviction=${d.conviction} should_trade=${d.shouldTrade} → ${d.outcome}${d.outcomeCode && d.outcomeCode !== d.outcome ? ` (${d.outcomeCode})` : ""}. ${d.outcomeMessage}`,
          });
        }
        setTimeout(() => setFlash(null), 12000);
        return j;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  // Opt-in auto-evaluate: browser-tab-bound, only while the run is RUNNING. No server-side scheduler exists.
  useEffect(() => {
    if (!autoEval) return;
    if (run?.status !== "RUNNING") {
      setAutoEval(false);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled || busy) return;
      const j = await decide("evaluate-and-trade", undefined, true);
      if (cancelled) return;
      setAutoLast(`${new Date().toLocaleTimeString()} — ${j?.skipped ? `waiting for next window (${j.ticker} already evaluated)` : j?.ok ? j.decision?.outcome : j?.code}`);
      await refresh();
    };
    tick();
    const id = setInterval(tick, 45_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEval, run?.status]);

  const post = async (url: string, body?: unknown) => {
    setBusy(true);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const j = await r.json();
      if (j.portfolio) setPortfolio(j.portfolio);
      if (j.run !== undefined) setRun(j.run);
      if (j.orders) setOrders(j.orders);
      if (j.config) setConfig(j.config);
      if (j.verification) setVerificationPreview(j.verification);
      return j;
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Request failed" };
    } finally {
      setBusy(false);
    }
  };

  const [verificationPreview, setVerificationPreview] = useState<MarketVerificationResult | null>(null);

  const say = (j: { ok: boolean; message?: string; code?: string }) => {
    setFlash(
      j.ok
        ? { kind: "ok", text: j.message ?? "PAPER order recorded (no real order placed)." }
        : { kind: "err", text: `REJECTED — ${j.code ?? "ERROR"}: ${j.message ?? "unknown error"}` }
    );
    setTimeout(() => setFlash(null), 9000);
  };

  const applyConfig = async () => {
    const j = await post("/api/paper/configure", { ...form, allowEarlyCashOut: false });
    say(j.ok ? { ok: true, message: "Strategy & risk limits applied. Manual start still required." } : j);
    refresh();
  };

  const runAction = async (action: string) => {
    const j = await post("/api/paper/run", { action });
    if (!j.ok) say(j);
    refresh();
  };

  const placeOrder = async (m: MarketVerificationResult, side: "yes" | "no") => {
    const j = await post("/api/paper/order", { market: m, side, contracts });
    say(j);
    refresh();
  };

  const settleNow = async () => {
    const j = await post("/api/paper/settle");
    say(j.ok ? { ok: true, message: `Settlement check complete: ${j.updated} settled, ${j.stillUnsettled} awaiting official result${j.hardStopTriggered ? " — HARD STOP TRIGGERED" : ""}.` } : j);
    refresh();
  };

  const runVerify = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/paper/verify-suite", { method: "POST" });
      setVerify(await r.json());
    } finally {
      setBusy(false);
    }
  };

  const loadSql = async () => {
    setShowSql((s) => !s);
    if (!sql) {
      const r = await fetch("/api/paper/schema-proposal", { cache: "no-store" });
      const j = await r.json();
      setSql(j.proposedSqlMigration ?? "");
    }
  };

  const gate = portfolio?.rules;
  const canTrade = run?.status === "RUNNING" && !gate?.hardStopReached && (orders.length === 0 || gate?.nextTradeUnlocked);

  return (
    <div className="space-y-4">
      {/* banner */}
      <div className="rounded-2xl border border-fuchsia-300/30 bg-fuchsia-500/[0.08] px-4 py-3 text-[13px] leading-relaxed text-fuchsia-100">
        <span className="font-bold text-fuchsia-200">PAPER-TRADING SIMULATOR — Kalshi Bitcoin (BTC) 15-Minute Up/Down ONLY.</span>{" "}
        Every balance, order, and P&L figure below is <span className="font-bold">PAPER / SIMULATED</span>. No real orders are placed,
        modified, or cancelled. No trading credentials, no account connection, no live-trading mode. Paper data is stored entirely in
        server memory and is fully isolated from your existing <span className="font-mono">daily_balances</span>, <span className="font-mono">trades</span>, <span className="font-mono">bot_logs</span>, and <span className="font-mono">kalshi_trades</span> tables.
      </div>

      {/* user directives */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { r: "1st bet ≤ $5.00", s: `Enforced cap ${money(gate?.firstBetCapDollars)}`, on: true },
          { r: "No early cash-out", s: "Hold to official settlement", on: config?.limits.allowEarlyCashOut === false },
          { r: "Never negative balance", s: `Cash ${money(portfolio?.availablePaperCashDollars)}`, on: true },
          { r: "+30% P&L unlocks next trade", s: `Now ${portfolio?.pnlPctOfStartingBalance ?? "—"}%`, on: Boolean(gate?.nextTradeUnlocked) },
          { r: "+75% P&L hard-stops run", s: gate?.hardStopReached ? "LOCKED — restart required" : "Armed", on: !gate?.hardStopReached },
          { r: "Manual start only", s: `Run: ${run?.status ?? "NOT STARTED"}`, on: run?.status === "RUNNING" },
        ].map((d) => (
          <div key={d.r} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-bold text-slate-100">{d.r}</p>
              <span className={`h-2 w-2 shrink-0 rounded-full ${d.on ? "bg-emerald-300" : "bg-amber-300"}`} />
            </div>
            <p className="mt-0.5 text-[11px] text-slate-400">{d.s}</p>
          </div>
        ))}
      </div>

      {flash && (
        <div className={`rounded-2xl border px-4 py-3 text-[13px] leading-relaxed ${flash.kind === "ok" ? "border-emerald-300/30 bg-emerald-400/[0.08] text-emerald-100" : "border-rose-300/30 bg-rose-500/[0.08] text-rose-100"}`}>
          {flash.text}
        </div>
      )}

      {gate?.blocker && run?.status === "RUNNING" && (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-400/[0.07] px-4 py-3 text-[13px] text-amber-100">
          <span className="font-bold">Write gate active:</span> {gate.blocker}
        </div>
      )}

      {/* STEP 1 — config */}
      <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-200">STEP 1 · STRATEGY & SIMULATED RISK LIMITS</h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${config ? "bg-emerald-400/15 text-emerald-200" : "bg-amber-400/15 text-amber-200"}`}>
            {config ? "CONFIGURED" : "UNSET — REQUIRED"}
          </span>
        </div>
        {!config && (
          <p className="mt-2 text-[13px] leading-relaxed text-slate-400">
            The simulator is locked until you supply a strategy and explicit limits. Nothing is invented and no unlimited exposure is possible.
            The numbers below are prefilled from <span className="font-semibold text-slate-200">your stated directives</span> — edit any of them, then apply.
          </p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="sm:col-span-2 block">
            <span className="mb-1 block text-[10px] font-bold tracking-widest text-slate-500">STRATEGY NAME</span>
            <input value={form.strategyName} onChange={(e) => setForm({ ...form, strategyName: e.target.value })} placeholder="e.g. BTC 15m momentum" className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-[13px] outline-none focus:border-fuchsia-300/50" />
          </label>
          <label className="sm:col-span-2 block">
            <span className="mb-1 block text-[10px] font-bold tracking-widest text-slate-500">EXPLICIT ENTRY RULE</span>
            <input value={form.strategyRule} onChange={(e) => setForm({ ...form, strategyRule: e.target.value })} placeholder="e.g. Buy YES only when YES ask <= 55¢" className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-[13px] outline-none focus:border-fuchsia-300/50" />
          </label>
          {([
            ["startingPaperBalanceDollars", "STARTING PAPER $"],
            ["maxStakeFirstTradeDollars", "1ST BET CAP $"],
            ["maxStakeDollars", "PER-TRADE CAP $"],
            ["maxDailyTrades", "DAILY TRADE MAX"],
            ["maxTotalExposureDollars", "TOTAL EXPOSURE $"],
            ["progressionGatePct", "PROGRESSION GATE %"],
            ["hardStopPct", "HARD STOP %"],
            ["feeRateBps", "FEE ASSUMPTION (bps)"],
          ] as const).map(([k, label]) => (
            <label key={k} className="block">
              <span className="mb-1 block text-[10px] font-bold tracking-widest text-slate-500">{label}</span>
              <input type="number" step="any" value={form[k] as number} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-[13px] outline-none focus:border-fuchsia-300/50" />
            </label>
          ))}
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold tracking-widest text-slate-500">SLIPPAGE (¢/contract)</span>
            <input type="number" step="any" value={form.slippageCentsPerContract} onChange={(e) => setForm({ ...form, slippageCentsPerContract: Number(e.target.value) })} className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-[13px] outline-none focus:border-fuchsia-300/50" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold tracking-widest text-slate-500">JEV MIN CONVICTION (0–3)</span>
            <input type="number" min={0} max={3} step={1} value={form.minConviction} onChange={(e) => setForm({ ...form, minConviction: Math.max(0, Math.min(3, Math.round(Number(e.target.value) || 0))) })} className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-[13px] outline-none focus:border-fuchsia-300/50" />
          </label>
        </div>
        <div className={`mt-3 rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${gateReachable ? "border-white/10 bg-white/[0.03] text-slate-400" : "border-amber-300/30 bg-amber-400/[0.07] text-amber-100"}`}>
          <span className="font-bold">Gate math (P&amp;L % is measured against your starting paper balance):</span> a {money(form.maxStakeFirstTradeDollars)} first bet at 50¢ wins about +{money(firstWinAt50)} = +{((firstWinAt50 / form.startingPaperBalanceDollars) * 100).toFixed(0)}% of {money(form.startingPaperBalanceDollars)}.
          Progression gate needs +{money(gateNeeds)}; hard stop fires at +{money(stopNeeds)}.
          {gateReachable ? " One winning first bet clears the gate." : " ⚠ A single first bet cannot reach the +gate — lower the starting balance or the gate %, otherwise the run ends after trade #1 regardless of outcome."}
          {" "}A losing first bet leaves P&amp;L below the gate, so the ladder ends (your "total loss" case).
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={applyConfig} disabled={busy || !form.strategyName || !form.strategyRule} className="rounded-xl bg-fuchsia-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-fuchsia-300 disabled:opacity-50">Apply strategy &amp; limits</button>
          <span className="text-[11px] text-slate-500">Assumptions stated: +{form.slippageCentsPerContract}¢/contract slippage, {form.feeRateBps} bps fee. Early cash-out is hard-disabled server-side.</span>
        </div>
      </section>

      {/* STEP 2 — run controls */}
      <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-200">STEP 2 · MANUAL RUN CONTROLS</h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${run?.status === "RUNNING" ? "bg-emerald-400/15 text-emerald-200" : run?.status === "PAUSED" ? "bg-amber-400/15 text-amber-200" : "bg-white/10 text-slate-300"}`}>
            {run ? run.status : "NOT STARTED"} {run?.hardStopTriggered ? "· HARD-STOPPED" : ""}
          </span>
        </div>
        <p className="mt-2 text-[12px] text-slate-400">Nothing auto-starts or runs on a schedule. Paused and stopped runs reject every simulated write server-side.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => runAction("start")} disabled={!config || busy} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50">▶ Manual start run</button>
          <button onClick={() => runAction("pause")} disabled={!run || busy} className="rounded-xl border border-amber-300/30 bg-amber-400/10 px-4 py-2 text-sm font-bold text-amber-200 disabled:opacity-40">⏸ Pause (block writes)</button>
          <button onClick={() => runAction("resume")} disabled={!run || busy} className="rounded-xl border border-white/15 bg-white/[0.05] px-4 py-2 text-sm font-semibold disabled:opacity-40">⏵ Resume</button>
          <button onClick={() => runAction("stop")} disabled={!run || busy} className="rounded-xl border border-rose-300/30 bg-rose-400/10 px-4 py-2 text-sm font-bold text-rose-200 disabled:opacity-40">⏹ Stop</button>
          <button onClick={() => runAction("reset")} disabled={busy} className="rounded-xl border border-white/15 bg-white/[0.05] px-4 py-2 text-sm font-semibold disabled:opacity-40">Reset paper session</button>
          <button onClick={settleNow} disabled={busy} className="ml-auto rounded-xl border border-sky-300/30 bg-sky-400/10 px-4 py-2 text-sm font-bold text-sky-200 disabled:opacity-40">⟳ Check official settlement</button>
        </div>
        {run?.stoppedReason && <p className="mt-2 text-[12px] text-rose-200">{run.stoppedReason}</p>}
      </section>

      {/* STEP 3 — markets */}
      <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-200">STEP 3 · VERIFIED KALSHI BTC 15-MINUTE UP/DOWN MARKETS</h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">Contracts
              <input type="number" min={1} value={contracts} onChange={(e) => setContracts(Math.max(1, Number(e.target.value) || 1))} className="w-16 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 font-mono text-[12px] outline-none focus:border-fuchsia-300/50" />
            </label>
            <button onClick={loadMarkets} disabled={busy} className="rounded-xl border border-white/15 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">↻ Rediscover</button>
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{discoveryInfo || "Discovering from Kalshi's read-only public API…"}</p>

        {markets.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center">
            <p className="text-sm font-medium text-slate-300">No verified in-scope markets right now</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
              Kalshi BTC 15-minute Up/Down markets exist in short windows. Nothing is faked to fill this panel — press Rediscover, or run the verification suite to confirm the filter still works.
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {markets.slice(0, 8).map((m) => {
              const ask = m.yesAskCents ?? m.lastPriceCents ?? 50;
              const stake = ((ask + (config?.assumptions.slippageCentsPerContract ?? 0)) / 100) * contracts;
              return (
                <div key={m.ticker} className="rounded-2xl border border-white/[0.07] bg-slate-950/50 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-[13px] font-bold text-slate-100">{m.ticker}</p>
                      <p className="text-[11px] text-slate-400">{m.title} · {time(m.openTime ?? "")} → {time(m.closeTime ?? "")} UTC</p>
                    </div>
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-300">{m.status}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(m.checks).map(([k, v]) => (
                      <span key={k} title={v.reason} className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${v.passed ? "bg-emerald-400/15 text-emerald-200" : "bg-rose-400/15 text-rose-200"}`}>
                        {k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim()} ✓
                      </span>
                    ))}
                    <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-bold text-sky-200">{m.intervalSeconds}s = 15m</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{m.rulesPrimary}</p>
                  <p className="mt-1 text-[11px] text-slate-500">Settlement: {(m.settlementSources ?? []).map((s) => s.name).join(", ") || "CF Benchmarks"} · {m.settlement.explanation}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/[0.07] pt-2">
                    <span className="font-mono text-[11px] text-slate-400">YES ask {m.yesAskCents ?? "—"}¢ · NO ask {m.noAskCents ?? "—"}¢</span>
                    <span className="font-mono text-[11px] text-fuchsia-200">PAPER stake ≈ {money(stake)} for {contracts}</span>
                    <div className="ml-auto flex gap-2">
                      <button onClick={() => placeOrder(m, "yes")} disabled={!canTrade || busy} className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-40">PAPER YES</button>
                      <button onClick={() => placeOrder(m, "no")} disabled={!canTrade || busy} className="rounded-lg bg-sky-400 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-sky-300 disabled:opacity-40">PAPER NO</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {excluded.length > 0 && (
          <details className="mt-3 rounded-2xl border border-white/10 bg-slate-950/40 p-3">
            <summary className="cursor-pointer text-[12px] font-bold text-slate-300">Excluded out-of-scope series &amp; markets ({excluded.length}) — with reasons</summary>
            <div className="mt-2 max-h-56 space-y-1.5 overflow-auto">
              {excluded.slice(0, 25).map((x, i) => (
                <div key={i} className="rounded-xl bg-white/[0.03] p-2 text-[11px]">
                  <p className="font-mono font-bold text-slate-300">{String(x.ticker || x.seriesTicker || "")}</p>
                  <p className="text-slate-500">{String(x.title || "")} · {String(x.frequency || "")} · {String(x.category || "")}</p>
                  <p className="mt-0.5 text-rose-200/80">{Array.isArray(x.reasons) ? x.reasons.join(" | ") : "out of scope"}</p>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* STEP 3b — Jev strategy engine */}
      <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-200">STEP 3b · STRATEGY ENGINE — JEV (TYPESAFE SYSTEM ONE)</h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${engine?.configured ? "bg-emerald-400/15 text-emerald-200" : "bg-amber-400/15 text-amber-200"}`}>
            {engine === null ? "checking…" : engine.configured ? `KEY CONFIGURED · ${engine.apiHost} · ${engine.model}` : "JEV_API_KEY NOT CONFIGURED"}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Your Python engine, ported server-side: one batched call asks <span className="font-mono">direction</span> (choice), <span className="font-mono">conviction</span> (score 0–3) and <span className="font-mono">should_trade</span> (noul). Jev returns typed probabilities only — no prose. The signal can never place an order by itself: an "evaluate &amp; paper-trade" still passes through every gate (run RUNNING, verified BTC 15m scope, first-bet ≤ ${config?.limits.maxStakeFirstTradeDollars ?? 5}, per-trade cap, +{config?.limits.progressionGatePct ?? 30}% progression gate, +{config?.limits.hardStopPct ?? 75}% hard stop, cash ≥ $0, no early cash-out).
        </p>
        {!engine?.configured && engine !== null && (
          <div className="mt-2 rounded-xl border border-amber-300/30 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-100">
            Add <span className="font-mono">JEV_API_KEY</span> (and optionally <span className="font-mono">JEV_API_URL</span>) through the platform's secure secret manager — never paste it in chat. Until then only the dry-run works, and no paper order will be generated from an invented signal.
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={() => decide("dry-run")} disabled={busy} className="rounded-xl border border-white/15 bg-white/[0.05] px-4 py-2 text-sm font-semibold disabled:opacity-50">Preview prompt (dry-run, no API call)</button>
          <button onClick={() => decide("evaluate")} disabled={busy || !engine?.configured} className="rounded-xl border border-fuchsia-300/40 bg-fuchsia-400/10 px-4 py-2 text-sm font-bold text-fuchsia-200 disabled:opacity-40">Ask Jev (evaluate only)</button>
          <button onClick={() => decide("evaluate-and-trade")} disabled={busy || !engine?.configured || run?.status !== "RUNNING"} className="rounded-xl bg-fuchsia-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-fuchsia-300 disabled:opacity-40">Ask Jev &amp; paper-trade current window</button>
          <label className={`ml-auto inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${autoEval ? "border-fuchsia-300/40 bg-fuchsia-400/10 text-fuchsia-100" : "border-white/10 bg-white/[0.03] text-slate-300"}`}>
            <input type="checkbox" checked={autoEval} disabled={!engine?.configured || run?.status !== "RUNNING"} onChange={(e) => setAutoEval(e.target.checked)} className="h-3.5 w-3.5 accent-fuchsia-400" />
            Auto-evaluate each new 15m window while RUNNING (this tab must stay open)
          </label>
        </div>
        {autoEval && <p className="mt-2 text-[11px] text-fuchsia-200/90">Auto mode: one Jev call per market per run, every 45s check, stops the moment the run is paused/stopped/hard-stopped or this tab closes. No server-side scheduler exists. Last: {autoLast || "starting…"}</p>}

        {dryRun && (
          <details className="mt-3 rounded-2xl border border-white/10 bg-slate-950/40 p-3" open>
            <summary className="cursor-pointer text-[12px] font-bold text-slate-300">Exact prompt that would be sent as Jev <span className="font-mono">state</span> for {dryRun.ticker}{dryRun.contextErrors.length ? ` · context warnings: ${dryRun.contextErrors.join("; ")}` : ""}</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-slate-950/70 p-3 text-[10px] leading-relaxed text-slate-300">{dryRun.prompt}</pre>
          </details>
        )}

        <div className="mt-3">
          <p className="text-[10px] font-bold tracking-widest text-slate-500">DECISION LOG (newest first)</p>
          {decisions.length === 0 ? (
            <p className="mt-1 text-[12px] text-slate-500">No Jev decisions yet in this session.</p>
          ) : (
            <div className="mt-2 max-h-72 space-y-1.5 overflow-auto pr-1">
              {decisions.map((d) => (
                <div key={d.decisionId} className={`rounded-xl border p-2.5 text-[11px] ${d.outcome === "PAPER_ORDER_RECORDED" ? "border-emerald-300/25 bg-emerald-400/[0.06]" : d.outcome === "ENGINE_ERROR" ? "border-rose-300/25 bg-rose-500/[0.06]" : "border-white/10 bg-white/[0.03]"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-slate-500">{new Date(d.createdAt).toLocaleTimeString()}</span>
                    <span className="font-mono font-bold text-slate-200">{d.ticker}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${d.direction === "up" ? "bg-emerald-400/15 text-emerald-200" : d.direction === "down" ? "bg-sky-400/15 text-sky-200" : "bg-white/10 text-slate-300"}`}>{d.direction}</span>
                    <span className="text-slate-400">conviction {d.conviction} · should_trade {String(d.shouldTrade)}</span>
                    <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold ${d.outcome === "PAPER_ORDER_RECORDED" ? "bg-emerald-400/15 text-emerald-200" : d.outcome === "BLOCKED" ? "bg-amber-400/15 text-amber-200" : d.outcome === "ENGINE_ERROR" ? "bg-rose-400/15 text-rose-200" : "bg-white/10 text-slate-300"}`}>{d.outcome}{d.outcomeCode && d.outcomeCode !== d.outcome ? ` · ${d.outcomeCode}` : ""}</span>
                  </div>
                  <p className="mt-1 text-slate-400">{d.outcomeMessage}</p>
                  {d.reasoning && <p className="mt-0.5 font-mono text-[10px] text-slate-500">{d.reasoning}</p>}
                  {d.parseErrors.length > 0 && <p className="mt-0.5 text-rose-200/80">parse: {d.parseErrors.join("; ")}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* STEP 4 — portfolio */}
      <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-200">STEP 4 · PAPER / SIMULATED PORTFOLIO &amp; ORDERS</h2>
          {config && <span className="text-[11px] text-slate-500">{config.assumptions.note}</span>}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { l: "PAPER CASH", v: money(portfolio?.availablePaperCashDollars), s: `start ${money(portfolio?.startingPaperBalanceDollars)}` },
            { l: "OPEN PAPER EXPOSURE", v: money(portfolio?.openExposureDollars), s: `cap ${money(config?.limits.maxTotalExposureDollars)}` },
            { l: "REALIZED P&L (PAPER)", v: money(portfolio?.realizedPnlDollars), s: `${portfolio?.pnlPctOfStartingBalance ?? "—"}% of start` },
            { l: "TRADES TODAY", v: `${portfolio?.todayTradeCount ?? 0}/${config?.limits.maxDailyTrades ?? "—"}`, s: `${portfolio?.settledOrdersCount ?? 0} settled · ${portfolio?.unsettledOrdersCount ?? 0} open` },
          ].map((c) => (
            <div key={c.l} className="rounded-2xl border border-white/[0.07] bg-slate-950/50 p-3">
              <p className="text-[10px] font-bold tracking-[0.15em] text-slate-500">{c.l}</p>
              <p className="mt-1 text-xl font-extrabold tracking-tight text-fuchsia-200">{c.v}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">{c.s}</p>
            </div>
          ))}
        </div>

        {orders.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center">
            <p className="text-sm font-medium text-slate-300">No PAPER orders yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">Configure limits, manually start a run, then place a PAPER order on a verified BTC 15-minute market above.</p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-slate-900/95 text-[10px] tracking-widest text-slate-500">
                <tr><th className="px-3 py-2">MARKET</th><th className="px-3 py-2">SIDE</th><th className="px-3 py-2 text-right">QTY</th><th className="px-3 py-2 text-right">FILL</th><th className="px-3 py-2 text-right">STAKE</th><th className="px-3 py-2">SETTLEMENT</th><th className="px-3 py-2 text-right">P&L (PAPER)</th></tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} className="border-t border-white/5 text-slate-300">
                    <td className="px-3 py-2 font-mono font-semibold text-slate-100">{o.ticker}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${o.side === "yes" ? "bg-emerald-400/15 text-emerald-200" : "bg-sky-400/15 text-sky-200"}`}>{o.side}</span></td>
                    <td className="px-3 py-2 text-right font-mono">{o.contracts}</td>
                    <td className="px-3 py-2 text-right font-mono">{o.effectiveFillCents}¢</td>
                    <td className="px-3 py-2 text-right font-mono">{money(o.totalStakeDollars)}</td>
                    <td className="px-3 py-2">
                      {o.settlementStatus === "SETTLED_VERIFIED_CF_BRTI" ? (
                        <span className="text-emerald-200">Official {String(o.officialResult).toUpperCase()} @ BRTI {String(o.officialExpirationValue)}</span>
                      ) : (
                        <span className="text-amber-200">UNSETTLED — no final result claimed</span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono font-bold ${(o.realizedPnlDollars ?? 0) < 0 ? "text-rose-300" : (o.realizedPnlDollars ?? 0) > 0 ? "text-emerald-300" : "text-slate-400"}`}>{o.realizedPnlDollars === null ? "—" : money(o.realizedPnlDollars)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* STEP 5 — verification */}
      <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-200">STEP 5 · VERIFICATION SUITE &amp; PROPOSED MIGRATION</h2>
          <button onClick={runVerify} disabled={busy} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50">Run verification suite</button>
        </div>
        {!verify ? (
          <p className="mt-2 text-[12px] text-slate-400">Runs 21 automated checks: scope filtering, rejection of BCH/ETH/SOL/hourly/missing-timestamp markets, unset &amp; unlimited limits, early cash-out refusal, first-bet cap, progression gate, non-negative balance, hard stop, paused/locked runs, settlement honesty, and existing-table isolation.</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
              <span className={`rounded-full px-3 py-1 font-bold ${verify.allPassed ? "bg-emerald-400/15 text-emerald-200" : "bg-rose-400/15 text-rose-200"}`}>{verify.passedCount}/{verify.totalCount} passed</span>
              <span className="text-slate-400">Live Kalshi API: {verify.liveKalshiReachable ? "reachable" : `unreachable (${verify.liveKalshiError ?? "error"})`}</span>
              <span className="text-slate-400">In-scope series: {verify.discoveredSeriesTickers.join(", ") || "none"}</span>
              <span className="text-slate-400">Verified markets: {verify.discoveredVerifiedMarketsCount}</span>
            </div>
            <div className="mt-3 max-h-72 space-y-1.5 overflow-auto pr-1">
              {verify.results.map((r) => (
                <div key={r.id} className={`rounded-xl border p-2.5 text-[11px] ${r.passed ? "border-emerald-300/20 bg-emerald-400/[0.05]" : "border-rose-300/25 bg-rose-500/[0.06]"}`}>
                  <div className="flex items-start gap-2">
                    <span className={`font-bold ${r.passed ? "text-emerald-300" : "text-rose-300"}`}>{r.passed ? "✓" : "✗"}</span>
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-200">{r.name} <span className="ml-1 font-mono text-[10px] text-slate-500">[{r.category}]</span></p>
                      <p className="text-slate-500">expected: {r.expected}</p>
                      <p className={r.passed ? "text-slate-400" : "text-rose-200"}>actual: {r.actual}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="mt-4 border-t border-white/[0.07] pt-3">
          <button onClick={loadSql} className="text-[12px] font-bold text-fuchsia-300 hover:text-fuchsia-200">
            {showSql ? "▾ Hide" : "▸ Show"} proposed paper-only Supabase migration (NOT applied)
          </button>
          {showSql && (
            <div className="mt-2">
              <div className="rounded-xl border border-amber-300/30 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-100">
                <span className="font-bold">NOT APPLIED — WAITING FOR YOUR APPROVAL.</span> No Supabase tables, policies, grants, or Edge Functions have been created or changed. Paper state currently lives in server memory only.
              </div>
              <pre className="mt-2 max-h-64 overflow-auto rounded-xl border border-white/10 bg-slate-950/70 p-3 text-[10px] leading-relaxed text-slate-300">{sql || "loading…"}</pre>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
