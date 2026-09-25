"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ALLOWED_TABLES, DEFAULT_SUPABASE_URL, PROJECT_REF } from "@/lib/supabase-safety";

type Row = Record<string, unknown>;
type TableName = (typeof ALLOWED_TABLES)[number];

type TableState = {
  rows: Row[];
  loading: boolean;
  error: string | null;
  code: string | null;
  via: string | null;
};

const emptyTableState = (): TableState => ({ rows: [], loading: false, error: null, code: null, via: null });

const LS_URL = "ro-dashboard:sb-url";
const LS_ANON = "ro-dashboard:sb-anon";

function str(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function pick(row: Row, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  }
  return null;
}
function fmtMoney(n: number | null, digits = 2): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtDate(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---- clearly-labeled demo data (never presented as real) ----
const DEMO_BALANCES: Row[] = [
  { balance_date: "2026-09-10", balance: 10240.5, equity: 10310.0 },
  { balance_date: "2026-09-12", balance: 10402.11, equity: 10440.0 },
  { balance_date: "2026-09-14", balance: 10318.77, equity: 10390.2 },
  { balance_date: "2026-09-16", balance: 10611.4, equity: 10680.0 },
  { balance_date: "2026-09-18", balance: 10572.9, equity: 10630.5 },
  { balance_date: "2026-09-20", balance: 10804.33, equity: 10890.0 },
  { balance_date: "2026-09-22", balance: 10741.08, equity: 10820.4 },
  { balance_date: "2026-09-25", balance: 10912.66, equity: 10988.1 },
];
const DEMO_TRADES: Row[] = [
  { id: 1, created_at: "2026-09-25T14:02:00Z", symbol: "DEMO-MARKET", side: "buy", quantity: 10, price: 62.5, pnl: 18.4, status: "settled" },
  { id: 2, created_at: "2026-09-24T18:40:00Z", symbol: "DEMO-MARKET", side: "sell", quantity: 5, price: 71.0, pnl: -6.2, status: "settled" },
];
const DEMO_LOGS: Row[] = [
  { id: 1, created_at: "2026-09-25T14:03:11Z", level: "info", bot_name: "demo-reader", message: "Demo log line — connect Supabase to see real bot_logs." },
  { id: 2, created_at: "2026-09-25T13:58:02Z", level: "warn", bot_name: "demo-reader", message: "No live bot detected in this preview (demo placeholder)." },
];
const DEMO_KALSHI: Row[] = [
  { id: 1, created_at: "2026-09-24T19:00:00Z", ticker: "DEMO-XYZ", side: "yes", count: 25, price: 58, status: "settled" },
];

async function queryServerProxy(table: TableName, limit: number): Promise<{ rows: Row[]; via: string }> {
  const r = await fetch(`/api/supabase/query?table=${table}&limit=${limit}`, { cache: "no-store" });
  const j = await r.json();
  if (!j.ok) {
    const err = new Error(j.message || "Server proxy query failed");
    (err as Error & { code?: string }).code = j.code || "PROXY_ERROR";
    throw err;
  }
  return { rows: j.rows as Row[], via: "server proxy (env anon key)" };
}

async function queryDirectBrowser(baseUrl: string, anon: string, table: TableName, limit: number): Promise<{ rows: Row[]; via: string }> {
  const order =
    table === "daily_balances"
      ? "balance_date.desc.nullslast"
      : "created_at.desc.nullslast";
  const rest = `${baseUrl.replace(/\/$/, "")}/rest/v1/${table}?select=*&limit=${limit}&order=${encodeURIComponent(order)}`;
  const r = await fetch(rest, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, Accept: "application/json" },
  });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    throw Object.assign(new Error(`Supabase returned non-JSON (${r.status}). ${text.slice(0, 200)}`), { code: "BAD_JSON" });
  }
  if (!r.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : text.slice(0, 400);
    const hint =
      r.status === 401 || r.status === 403
        ? " — RLS likely blocked the anon read, or the key is wrong. Policies were not weakened."
        : "";
    throw Object.assign(new Error(`Supabase ${r.status}: ${msg}${hint}`), { code: `HTTP_${r.status}` });
  }
  return { rows: (Array.isArray(data) ? data : []) as Row[], via: "browser → Supabase REST (your anon key, never sent to our server)" };
}

function BalanceChart({ rows, demo }: { rows: Row[]; demo: boolean }) {
  const pts = useMemo(() => {
    const sorted = [...rows]
      .map((r) => ({
        d: String(pick(r, ["balance_date", "date", "created_at", "day"]) ?? ""),
        v: num(pick(r, ["balance", "equity", "total", "value", "nav"])),
      }))
      .filter((p) => p.v !== null)
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    return sorted as { d: string; v: number }[];
  }, [rows]);

  if (pts.length === 0) {
    return (
      <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] text-center">
        <p className="text-sm font-medium text-slate-300">No balance points to chart</p>
        <p className="max-w-xs text-xs leading-relaxed text-slate-500">
          daily_balances returned zero rows. That is a valid empty state — not an error, and not proof of trading.
        </p>
      </div>
    );
  }
  const W = 560, H = 180, P = 18;
  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const xy = pts.map((p, i) => {
    const x = P + (i * (W - P * 2)) / Math.max(pts.length - 1, 1);
    const y = H - P - ((p.v - min) / span) * (H - P * 2);
    return { x, y, ...p };
  });
  const line = xy.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${xy[xy.length - 1].x.toFixed(1)},${H - P} L${xy[0].x.toFixed(1)},${H - P} Z`;
  return (
    <div className="relative">
      {demo && <span className="absolute right-3 top-3 rounded-full bg-amber-400/15 px-2.5 py-1 text-[10px] font-bold tracking-widest text-amber-300">DEMO — NOT FROM SUPABASE</span>}
      <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full">
        <defs>
          <linearGradient id="balfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={P} x2={W - P} y1={H * f} y2={H * f} stroke="rgba(255,255,255,0.07)" strokeDasharray="4 4" />
        ))}
        <path d={area} fill="url(#balfill)" />
        <path d={line} fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" />
        {xy.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3" fill="#0b1220" stroke="#34d399" strokeWidth="2" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{fmtDate(xy[0]?.d)}</span>
        <span className="text-slate-400">{pts.length} points · {fmtMoney(min)} → {fmtMoney(max)}</span>
        <span>{fmtDate(xy[xy.length - 1]?.d)}</span>
      </div>
    </div>
  );
}

function StateShell({ state, emptyTitle, emptyHint, children }: { state: TableState; emptyTitle: string; emptyHint: string; children: React.ReactNode }) {
  if (state.loading) {
    return (
      <div className="space-y-2 py-4" aria-live="polite">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-xl bg-white/[0.05]" />
        ))}
        <p className="text-xs text-slate-500">Loading from Supabase…</p>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="rounded-2xl border border-rose-400/25 bg-rose-500/[0.07] p-4">
        <p className="text-sm font-semibold text-rose-200">Couldn’t load this table</p>
        <p className="mt-1 break-words text-xs leading-relaxed text-rose-200/80">{state.error}</p>
        {state.code && <p className="mt-1 font-mono text-[11px] text-rose-300/70">code: {state.code}</p>}
        <p className="mt-2 text-[11px] text-slate-400">No fake data was substituted. Fix the cause, then retry.</p>
      </div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center">
        <div className="grid h-9 w-9 place-items-center rounded-full bg-white/[0.06] text-base">∅</div>
        <p className="text-sm font-medium text-slate-300">{emptyTitle}</p>
        <p className="max-w-sm text-xs leading-relaxed text-slate-500">{emptyHint}</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function Dashboard() {
  const [sbUrl, setSbUrl] = useState(DEFAULT_SUPABASE_URL);
  const [anonKey, setAnonKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [serverConfigured, setServerConfigured] = useState<boolean | null>(null);
  const [serverHost, setServerHost] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [localCounts, setLocalCounts] = useState<Record<string, number | null> | null>(null);
  const [tables, setTables] = useState<Record<TableName, TableState>>({
    daily_balances: emptyTableState(),
    trades: emptyTableState(),
    bot_logs: emptyTableState(),
    kalshi_trades: emptyTableState(),
  });
  const [demoMode, setDemoMode] = useState(false);
  const [logFilter, setLogFilter] = useState("");
  const [tradeQuery, setTradeQuery] = useState("");
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    try {
      const u = localStorage.getItem(LS_URL);
      const k = localStorage.getItem(LS_ANON);
      if (u) setSbUrl(u);
      if (k) {
        setAnonKey(k);
        setConnected(true);
      }
    } catch { /* private mode */ }
    (async () => {
      try {
        const r = await fetch("/api/supabase/status", { cache: "no-store" });
        const j = await r.json();
        setServerConfigured(Boolean(j.serverConfigured));
        setServerHost(j.serverHost ?? null);
      } catch {
        setServerConfigured(false);
      } finally {
        setStatusLoading(false);
      }
      try {
        const r = await fetch("/api/local/counts", { cache: "no-store" });
        const j = await r.json();
        if (j.ok) setLocalCounts(j.counts);
      } catch { /* ignore */ }
    })();
  }, []);

  const loadAll = useCallback(async (opts?: { url?: string; key?: string }) => {
    const url = (opts?.url ?? sbUrl).trim().replace(/\/$/, "");
    const key = (opts?.key ?? anonKey).trim();
    const useServer = serverConfigured === true;
    const useDirect = !useServer && Boolean(url && key);

    if (!useServer && !useDirect) {
      // No credentials anywhere: mark every table as blocked with honest error.
      setTables((prev) => {
        const next = { ...prev };
        for (const t of ALLOWED_TABLES) {
          next[t] = { rows: [], loading: false, error: "Not connected. Enter your Supabase URL + publishable (anon) key above, or configure SUPABASE_URL / SUPABASE_ANON_KEY via the platform secret manager — then retry. Nothing was invented to fill this panel.", code: "NOT_CONNECTED", via: null };
        }
        return next;
      });
      return;
    }

    setTables((prev) => {
      const next = { ...prev };
      for (const t of ALLOWED_TABLES) next[t] = { ...next[t], loading: true, error: null, code: null };
      return next;
    });

    await Promise.all(
      ALLOWED_TABLES.map(async (t) => {
        try {
          const res = useServer
            ? await queryServerProxy(t, t === "daily_balances" ? 100 : 50)
            : await queryDirectBrowser(url, key, t, t === "daily_balances" ? 100 : 50);
          setTables((prev) => ({ ...prev, [t]: { rows: res.rows, loading: false, error: null, code: null, via: res.via } }));
        } catch (e) {
          const err = e as Error & { code?: string };
          setTables((prev) => ({ ...prev, [t]: { rows: [], loading: false, error: err.message, code: err.code ?? "LOAD_ERROR", via: null } }));
        }
      })
    );
    setLastRefresh(new Date().toLocaleTimeString());
  }, [sbUrl, anonKey, serverConfigured]);

  // Auto-load once we know server status (server proxy) or saved browser creds.
  useEffect(() => {
    if (statusLoading) return;
    if (serverConfigured === true) loadAll();
    else {
      try {
        const k = localStorage.getItem(LS_ANON);
        if (k) loadAll();
        else {
          setTables((prev) => {
            const next = { ...prev };
            for (const t of ALLOWED_TABLES) {
              next[t] = { rows: [], loading: false, error: "Not connected. Enter your Supabase URL + publishable (anon) key above, or configure SUPABASE_URL / SUPABASE_ANON_KEY via the platform secret manager — then retry. Nothing was invented to fill this panel.", code: "NOT_CONNECTED", via: null };
            }
            return next;
          });
        }
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusLoading, serverConfigured]);

  const handleConnect = () => {
    const u = sbUrl.trim();
    const k = anonKey.trim();
    if (!u || !k) return;
    try {
      localStorage.setItem(LS_URL, u);
      localStorage.setItem(LS_ANON, k);
    } catch { /* ignore */ }
    setConnected(true);
    loadAll({ url: u, key: k });
  };
  const handleDisconnect = () => {
    try {
      localStorage.removeItem(LS_ANON);
    } catch { /* ignore */ }
    setAnonKey("");
    setConnected(false);
  };

  // ---- derived stats (live rows only; demo never leaks into "live" numbers) ----
  const live = tables;
  const balancesSorted = useMemo(() => {
    const rows = [...live.daily_balances.rows].sort((a, b) => String(pick(a, ["balance_date", "date", "created_at"]) ?? "") < String(pick(b, ["balance_date", "date", "created_at"]) ?? "") ? -1 : 1);
    return rows;
  }, [live.daily_balances.rows]);
  const latestBalance = balancesSorted.length ? num(pick(balancesSorted[balancesSorted.length - 1], ["balance", "equity", "total", "value"])) : null;
  const prevBalance = balancesSorted.length > 1 ? num(pick(balancesSorted[balancesSorted.length - 2], ["balance", "equity", "total", "value"])) : null;
  const delta = latestBalance !== null && prevBalance !== null ? latestBalance - prevBalance : null;
  const totalPnl = useMemo(() => live.trades.rows.reduce((s, r) => s + (num(pick(r, ["pnl", "profit", "realized_pnl"])) ?? 0), 0), [live.trades.rows]);
  const anyLoading = Object.values(live).some((t) => t.loading);
  const anyError = Object.values(live).some((t) => t.error);

  const filteredLogs = useMemo(() => {
    const rows = demoMode && live.bot_logs.rows.length === 0 && !live.bot_logs.error ? DEMO_LOGS : live.bot_logs.rows;
    const q = logFilter.trim().toLowerCase();
    if (!q) return rows.slice(0, 30);
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)).slice(0, 30);
  }, [live.bot_logs.rows, live.bot_logs.error, logFilter, demoMode]);

  const filteredTrades = useMemo(() => {
    const rows = demoMode && live.trades.rows.length === 0 && !live.trades.error ? DEMO_TRADES : live.trades.rows;
    const q = tradeQuery.trim().toLowerCase();
    if (!q) return rows.slice(0, 25);
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)).slice(0, 25);
  }, [live.trades.rows, live.trades.error, tradeQuery, demoMode]);

  const kalshiRows = demoMode && live.kalshi_trades.rows.length === 0 && !live.kalshi_trades.error ? DEMO_KALSHI : live.kalshi_trades.rows;
  const chartRows = demoMode && live.daily_balances.rows.length === 0 && !live.daily_balances.error ? DEMO_BALANCES : live.daily_balances.rows;
  const chartIsDemo = demoMode && live.daily_balances.rows.length === 0 && !live.daily_balances.error;

  const verifiedCount = ALLOWED_TABLES.filter((t) => !live[t].loading && !live[t].error).length;

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100">
      {/* top glow */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(52,211,153,0.14),transparent)]" />

      <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">
        {/* header */}
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 font-black text-slate-950">◈</div>
            <div>
              <p className="text-[11px] font-bold tracking-[0.2em] text-emerald-300/80">PULSE · READ-ONLY MONITOR</p>
              <h1 className="text-xl font-bold leading-tight sm:text-2xl">Trading activity dashboard</h1>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-emerald-300/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-bold tracking-wide text-emerald-200">READ-ONLY · NO LIVE TRADING</span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[11px] text-slate-300">ref: {PROJECT_REF}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ${connected || serverConfigured ? "bg-emerald-400/10 text-emerald-200" : "bg-amber-400/10 text-amber-200"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${anyLoading ? "animate-pulse bg-sky-300" : connected || serverConfigured ? "bg-emerald-300" : "bg-amber-300"}`} />
              {statusLoading ? "checking…" : serverConfigured ? `server proxy · ${serverHost ?? "supabase"}` : connected ? "browser key set" : "not connected"}
            </span>
          </div>
        </header>

        {/* honesty banner */}
        <div className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-400/[0.07] px-4 py-3 text-[13px] leading-relaxed text-amber-100/90">
          <span className="font-bold text-amber-200">Read-only dashboard — no deployed bot functions detected.</span>{" "}
          Table records (if any) do not prove a live trading bot is running. This app cannot place orders: no Alpaca / Kalshi / broker
          order APIs, no trading credentials, no write paths. Verified tables this session: <span className="font-bold">{verifiedCount} / 4</span>.
        </div>

        {/* connection card */}
        <section className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold tracking-wide text-slate-200">SUPABASE CONNECTION</h2>
              {lastRefresh && <p className="text-[11px] text-slate-500">last refresh {lastRefresh}</p>}
            </div>
            {serverConfigured === true ? (
              <div className="mt-3 rounded-2xl border border-emerald-300/25 bg-emerald-400/[0.07] p-3 text-[13px] text-emerald-100/90">
                Server proxy is configured{serverHost ? <> (host <span className="font-mono">{serverHost}</span>)</> : null} and uses the
                publishable key server-side. Your browser never sees a secret. Press reload to re-read the four tables.
              </div>
            ) : (
              <>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-400">
                  Server proxy is <span className="font-semibold text-amber-200">not configured</span> in this preview. Paste your Supabase URL
                  and <span className="font-semibold text-slate-200">publishable / anon key only</span> to read directly from the browser.
                  The key stays in this browser’s localStorage and goes straight to Supabase — never to our server, never to logs.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500">SUPABASE URL</span>
                    <input
                      value={sbUrl}
                      onChange={(e) => setSbUrl(e.target.value)}
                      spellCheck={false}
                      placeholder={DEFAULT_SUPABASE_URL}
                      className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2.5 font-mono text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-300/50"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 flex items-center justify-between text-[11px] font-bold tracking-widest text-slate-500">
                      PUBLISHABLE (ANON) KEY
                      <button type="button" onClick={() => setShowKey((s) => !s)} className="font-semibold normal-case tracking-normal text-emerald-300/90 hover:text-emerald-200">
                        {showKey ? "hide" : "show"}
                      </button>
                    </span>
                    <input
                      value={anonKey}
                      onChange={(e) => setAnonKey(e.target.value)}
                      spellCheck={false}
                      type={showKey ? "text" : "password"}
                      placeholder="eyJhbGciOi…  or  sb_publishable_…"
                      className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2.5 font-mono text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-300/50"
                    />
                  </label>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Never paste a <span className="font-semibold text-rose-300">service_role / secret</span> key, database password, or broker key here
                  or in chat. Configure server secrets only through the platform’s secure secret manager. This form accepts the publishable key only;
                  the server proxy refuses service_role outright.
                </p>
              </>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {serverConfigured === true ? (
                <button onClick={() => loadAll()} disabled={anyLoading} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50">
                  {anyLoading ? "Reading…" : "↻ Reload all four tables"}
                </button>
              ) : connected ? (
                <>
                  <button onClick={() => loadAll()} disabled={anyLoading} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50">
                    {anyLoading ? "Reading…" : "↻ Reload all four tables"}
                  </button>
                  <button onClick={handleDisconnect} className="rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-white/[0.08]">
                    Disconnect & clear key
                  </button>
                </>
              ) : (
                <button onClick={handleConnect} disabled={!sbUrl.trim() || !anonKey.trim() || anyLoading} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50">
                  {anyLoading ? "Reading…" : "Connect & load (read-only)"}
                </button>
              )}
              <label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300">
                <input type="checkbox" checked={demoMode} onChange={(e) => setDemoMode(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-400" />
                Preview UI with labeled demo data
              </label>
            </div>
          </div>

          {/* proof / verification */}
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-sm font-bold tracking-wide text-slate-200">VERIFICATION & PROOF</h2>
            <ul className="mt-3 space-y-2 text-[13px] leading-relaxed">
              {ALLOWED_TABLES.map((t) => {
                const s = tables[t];
                return (
                  <li key={t} className="flex items-start gap-2">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.loading ? "animate-pulse bg-sky-300" : s.error ? "bg-rose-400" : "bg-emerald-300"}`} />
                    <span className="font-mono text-[12px] text-slate-200">{t}</span>
                    <span className="text-slate-400">
                      {s.loading ? "reading…" : s.error ? <>blocked — <span className="text-rose-200/90">{s.code}</span></> : s.rows.length === 0 ? "reachable · 0 rows (empty, honest)" : <>reachable · <span className="font-bold text-emerald-200">{s.rows.length} rows</span> via {s.via?.includes("server") ? "server proxy" : "browser REST"}</>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-xl bg-white/[0.03] p-2.5 text-slate-400">RLS <span className="block font-bold text-slate-200">never weakened · never bypassed</span></div>
              <div className="rounded-xl bg-white/[0.03] p-2.5 text-slate-400">Edge Functions <span className="block font-bold text-slate-200">0 created · 0 called</span></div>
              <div className="rounded-xl bg-white/[0.03] p-2.5 text-slate-400">Supabase writes <span className="block font-bold text-slate-200">0 — GET only</span></div>
              <div className="rounded-xl bg-white/[0.03] p-2.5 text-slate-400">Local mirror {localCounts ? <span className="block font-mono text-slate-200">{Object.entries(localCounts).map(([k, v]) => `${k.split("_")[0]}:${v ?? "?"}`).join(" · ")}</span> : <span className="block font-bold text-slate-200">checking…</span>}</div>
            </div>
          </div>
        </section>

        {/* stats */}
        <section className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "LATEST BALANCE", value: anyLoading ? "…" : fmtMoney(latestBalance), sub: delta !== null ? `${delta >= 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(delta))} vs prior day` : balancesSorted.length <= 1 && latestBalance !== null ? "only one balance row" : "no balance rows — empty state", tone: delta !== null && delta < 0 ? "rose" : "emerald" },
            { label: "TRADES (LOADED)", value: anyLoading ? "…" : live.trades.error ? "blocked" : String(live.trades.rows.length), sub: live.trades.error ? "see trades panel for exact error" : `realized P&L (loaded rows): ${fmtMoney(totalPnl)}`, tone: "sky" },
            { label: "KALSHI RECORDS", value: anyLoading ? "…" : live.kalshi_trades.error ? "blocked" : String(live.kalshi_trades.rows.length), sub: "read-only event-contract records", tone: "violet" },
            { label: "BOT LOG LINES", value: anyLoading ? "…" : live.bot_logs.error ? "blocked" : String(live.bot_logs.rows.length), sub: "logs ≠ proof a bot is running", tone: "amber" },
          ].map((c) => (
            <div key={c.label} className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-[10px] font-bold tracking-[0.18em] text-slate-500">{c.label}</p>
              <p className="mt-1 text-2xl font-extrabold tracking-tight">{c.value}</p>
              <p className={`mt-1 text-xs ${c.tone === "rose" ? "text-rose-300" : c.tone === "emerald" ? "text-emerald-300" : "text-slate-400"}`}>{c.sub}</p>
            </div>
          ))}
        </section>

        {/* balances + logs */}
        <section className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold tracking-wide text-slate-200">BALANCES OVER TIME · daily_balances</h2>
              <button onClick={() => loadAll()} className="text-xs font-semibold text-emerald-300 hover:text-emerald-200">retry</button>
            </div>
            <div className="mt-3">
              <StateShell state={live.daily_balances} emptyTitle="daily_balances is empty" emptyHint="The table is reachable but has zero rows. Enable “labeled demo data” above to preview the chart shape — demo points are watermarked and never counted as real.">
                <BalanceChart rows={live.daily_balances.rows} demo={false} />
              </StateShell>
              {chartIsDemo && (
                <div className="mt-3">
                  <BalanceChart rows={chartRows} demo />
                  <p className="mt-2 text-[11px] text-amber-200/90">Showing watermarked demo shape because live daily_balances is empty. Connect Supabase to replace it with real rows.</p>
                </div>
              )}
              {!live.daily_balances.loading && !live.daily_balances.error && live.daily_balances.rows.length > 0 && (
                <div className="mt-3 max-h-40 overflow-auto rounded-2xl border border-white/10">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-900/95 text-[10px] tracking-widest text-slate-500">
                      <tr><th className="px-3 py-2">DATE</th><th className="px-3 py-2 text-right">BALANCE</th><th className="px-3 py-2 text-right">EQUITY</th></tr>
                    </thead>
                    <tbody>
                      {balancesSorted.slice(-10).reverse().map((r, i) => (
                        <tr key={i} className="border-t border-white/5 text-slate-300">
                          <td className="px-3 py-1.5">{fmtDate(pick(r, ["balance_date", "date", "created_at"]))}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmtMoney(num(pick(r, ["balance", "total", "value"])))}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmtMoney(num(pick(r, ["equity", "nav"])))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold tracking-wide text-slate-200">BOT LOGS · bot_logs</h2>
              <input value={logFilter} onChange={(e) => setLogFilter(e.target.value)} placeholder="filter…" className="w-28 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
            </div>
            <div className="mt-3">
              <StateShell state={live.bot_logs} emptyTitle="bot_logs is empty" emptyHint="No log lines returned. Old logs alone would not prove a bot is currently running — and right now there are none to misread.">
                <div className="max-h-80 space-y-2 overflow-auto pr-1">
                  {filteredLogs.map((r, i) => {
                    const lvl = String(pick(r, ["level", "severity"]) ?? "info").toLowerCase();
                    const color = lvl.includes("error") || lvl.includes("crit") ? "rose" : lvl.includes("warn") ? "amber" : lvl.includes("debug") ? "slate" : "emerald";
                    return (
                      <div key={String(pick(r, ["id"]) ?? i)} className="rounded-2xl border border-white/[0.07] bg-slate-950/50 p-3">
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className={`rounded-full px-2 py-0.5 font-bold uppercase tracking-wider ${color === "rose" ? "bg-rose-400/15 text-rose-200" : color === "amber" ? "bg-amber-400/15 text-amber-200" : color === "emerald" ? "bg-emerald-400/15 text-emerald-200" : "bg-white/10 text-slate-300"}`}>{lvl}</span>
                          <span className="font-mono text-slate-500">{fmtTime(pick(r, ["created_at", "logged_at", "timestamp"]))}</span>
                          {Boolean(pick(r, ["bot_name", "bot", "source"])) && <span className="ml-auto font-mono text-slate-500">{str(pick(r, ["bot_name", "bot", "source"]))}</span>}
                        </div>
                        <p className="mt-1.5 break-words text-[13px] leading-relaxed text-slate-200">{str(pick(r, ["message", "msg", "log", "text"]))}</p>
                      </div>
                    );
                  })}
                  {filteredLogs.length === 0 && <p className="py-6 text-center text-xs text-slate-500">Filter matched zero of {live.bot_logs.rows.length} loaded lines.</p>}
                </div>
              </StateShell>
              {demoMode && live.bot_logs.rows.length === 0 && !live.bot_logs.error && (
                <div className="mt-2 rounded-2xl border border-amber-300/30 bg-amber-400/[0.06] p-3 text-[11px] text-amber-100/90">
                  <span className="font-bold">DEMO PREVIEW — not from Supabase.</span> Showing {DEMO_LOGS.length} placeholder lines so you can judge the layout.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* trades + kalshi */}
        <section className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold tracking-wide text-slate-200">RECENT TRADES · trades</h2>
              <input value={tradeQuery} onChange={(e) => setTradeQuery(e.target.value)} placeholder="search symbol / side…" className="w-44 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
            </div>
            <div className="mt-3">
              <StateShell state={live.trades} emptyTitle="trades is empty" emptyHint="The table is reachable but returned zero rows. No positions were invented — an empty ledger is honest data.">
                <div className="overflow-x-auto rounded-2xl border border-white/10">
                  <table className="w-full min-w-[560px] text-left text-xs">
                    <thead className="bg-slate-900/95 text-[10px] tracking-widest text-slate-500">
                      <tr><th className="px-3 py-2">TIME</th><th className="px-3 py-2">SYMBOL</th><th className="px-3 py-2">SIDE</th><th className="px-3 py-2 text-right">QTY</th><th className="px-3 py-2 text-right">PRICE</th><th className="px-3 py-2 text-right">P&L</th></tr>
                    </thead>
                    <tbody>
                      {filteredTrades.map((r, i) => {
                        const pnl = num(pick(r, ["pnl", "profit", "realized_pnl"]));
                        const side = String(pick(r, ["side", "direction"]) ?? "—").toLowerCase();
                        return (
                          <tr key={String(pick(r, ["id"]) ?? i)} className="border-t border-white/5 text-slate-300">
                            <td className="whitespace-nowrap px-3 py-2 text-slate-400">{fmtTime(pick(r, ["created_at", "executed_at", "timestamp", "filled_at"]))}</td>
                            <td className="px-3 py-2 font-mono font-semibold text-slate-100">{str(pick(r, ["symbol", "ticker", "market", "instrument"]))}</td>
                            <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${side.startsWith("buy") || side === "yes" || side === "long" ? "bg-emerald-400/15 text-emerald-200" : side.startsWith("sell") || side === "no" || side === "short" ? "bg-rose-400/15 text-rose-200" : "bg-white/10 text-slate-300"}`}>{str(pick(r, ["side", "direction"]))}</span></td>
                            <td className="px-3 py-2 text-right font-mono">{str(pick(r, ["quantity", "qty", "size", "amount", "contracts"]))}</td>
                            <td className="px-3 py-2 text-right font-mono">{str(pick(r, ["price", "fill_price", "avg_price"]))}</td>
                            <td className={`px-3 py-2 text-right font-mono font-bold ${pnl !== null && pnl < 0 ? "text-rose-300" : pnl !== null && pnl > 0 ? "text-emerald-300" : "text-slate-400"}`}>{pnl === null ? "—" : fmtMoney(pnl)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </StateShell>
              {demoMode && live.trades.rows.length === 0 && !live.trades.error && (
                <p className="mt-2 rounded-xl border border-amber-300/30 bg-amber-400/[0.06] p-2.5 text-[11px] text-amber-100/90"><span className="font-bold">DEMO PREVIEW — not from Supabase.</span></p>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-sm font-bold tracking-wide text-slate-200">KALSHI RECORDS · kalshi_trades</h2>
            <div className="mt-3">
              <StateShell state={live.kalshi_trades} emptyTitle="kalshi_trades is empty" emptyHint="No Kalshi fills returned. This panel reads fills only — it can never place a Kalshi order.">
                <div className="space-y-2">
                  {kalshiRows.slice(0, 12).map((r, i) => (
                    <div key={String(pick(r, ["id"]) ?? i)} className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-slate-950/50 p-3 text-xs">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono font-bold text-slate-100">{str(pick(r, ["ticker", "market", "symbol", "contract"]))}</p>
                        <p className="truncate text-slate-500">{str(pick(r, ["market_title", "title", "event"]))} · {fmtTime(pick(r, ["created_at", "executed_at"]))}</p>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${String(pick(r, ["side"]) ?? "").toLowerCase() === "yes" ? "bg-emerald-400/15 text-emerald-200" : "bg-sky-400/15 text-sky-200"}`}>{str(pick(r, ["side", "action"]))}</span>
                      <span className="font-mono text-slate-200">×{str(pick(r, ["count", "quantity", "contracts"]))} @ {str(pick(r, ["price", "yes_price", "cents"]))}¢</span>
                    </div>
                  ))}
                </div>
              </StateShell>
              {demoMode && live.kalshi_trades.rows.length === 0 && !live.kalshi_trades.error && (
                <p className="mt-2 rounded-xl border border-amber-300/30 bg-amber-400/[0.06] p-2.5 text-[11px] text-amber-100/90"><span className="font-bold">DEMO PREVIEW — not from Supabase.</span></p>
              )}
            </div>
          </div>
        </section>

        {/* acceptance / smoke */}
        <section className="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="text-sm font-bold tracking-wide text-slate-200">ACCEPTANCE CHECKS · SMOKE TEST</h2>
          <div className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-2xl bg-white/[0.03] p-3"><p className="font-bold text-emerald-200">✓ Preview opens to a nonblank dashboard</p><p className="text-slate-400">This page renders chrome + empty/error states even with zero rows.</p></div>
            <div className="rounded-2xl bg-white/[0.03] p-3"><p className={`font-bold ${anyError || (!connected && !serverConfigured) ? "text-amber-200" : "text-emerald-200"}`}>{anyError || (!connected && !serverConfigured) ? "○ Live rows pending connection" : "✓ Displayed records come from Supabase"}</p><p className="text-slate-400">{serverConfigured ? "Rows above arrived via server proxy (anon key, RLS enforced)." : connected ? "Rows above arrived via browser REST with your anon key." : "Connect to verify — demo rows are watermarked and excluded from live counts."}</p></div>
            <div className="rounded-2xl bg-white/[0.03] p-3"><p className="font-bold text-emerald-200">✓ Loading · empty · error states</p><p className="text-slate-400">Skeletons while reading, ∅ panels when empty, exact Supabase error + retry when blocked.</p></div>
            <div className="rounded-2xl bg-white/[0.03] p-3"><p className="font-bold text-slate-200">Tables & policies verified this session</p><p className="text-slate-400">{verifiedCount}/4 tables returned rows or confirmed empty via SELECT. {anyError ? "Blocked tables show the real RLS/auth error — policies were not changed to force access." : "Policy detail: anon SELECT succeeded where rows/empty shown."}</p></div>
            <div className="rounded-2xl bg-white/[0.03] p-3"><p className="font-bold text-slate-200">Changed vs not changed</p><p className="text-slate-400">Changed: this preview’s UI + read-only API proxy only. Not changed: Supabase tables, rows, RLS policies, grants, Edge Functions (none created, none called).</p></div>
            <div className="rounded-2xl bg-white/[0.03] p-3"><p className="font-bold text-slate-200">If blocked, the precise blocker</p><p className="text-slate-400">{!serverConfigured && !connected ? "Blocker: no Supabase credentials in this preview. Add URL + anon key above." : anyError ? "Blocker shown per-table above (HTTP code + Supabase message)." : "No blocker — all four reads resolved."}</p></div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.07] pt-3 text-[11px] text-slate-500">
            <span className="rounded-full bg-white/[0.04] px-2.5 py-1">GET /api/health</span>
            <span className="rounded-full bg-white/[0.04] px-2.5 py-1">GET /api/supabase/status</span>
            <span className="rounded-full bg-white/[0.04] px-2.5 py-1">GET /api/supabase/query?table=… (allowlist of 4)</span>
            <span className="rounded-full bg-white/[0.04] px-2.5 py-1">POST/PUT/PATCH/DELETE → 405 READ_ONLY</span>
            <span className="rounded-full bg-white/[0.04] px-2.5 py-1">service_role → 403 REFUSED</span>
          </div>
        </section>

        <footer className="mt-6 text-center text-[11px] leading-relaxed text-slate-600">
          Read-only build · no order-placement code · no broker SDKs · secrets only via platform secret manager, never in chat or logs.<br />
          Supabase ref <span className="font-mono">{PROJECT_REF}</span> · tables daily_balances, trades, bot_logs, kalshi_trades.
        </footer>
      </div>
    </div>
  );
}
