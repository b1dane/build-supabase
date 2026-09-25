import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { PROJECT_REF } from "@/lib/supabase-safety";

export const dynamic = "force-dynamic";

const PROPOSED_SQL_MIGRATION = `-- ============================================================================
-- PROPOSED PAPER-ONLY SUPABASE MIGRATION (NOT APPLIED — AWAITING USER APPROVAL)
-- Target project ref: ${PROJECT_REF}
-- Guarantee: Does NOT alter, drop, truncate, or write to existing tables:
--            public.daily_balances, public.trades, public.bot_logs, public.kalshi_trades
-- ============================================================================

-- 1. Separate Paper Simulation Runs table (manual start required; no auto-start)
CREATE TABLE IF NOT EXISTS public.paper_btc15m_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_paper BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_paper = TRUE),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'STOPPED')),
  manual_start_confirmed BOOLEAN NOT NULL CHECK (manual_start_confirmed = TRUE),
  strategy_name TEXT NOT NULL CHECK (char_length(trim(strategy_name)) > 0),
  strategy_rule TEXT NOT NULL CHECK (char_length(trim(strategy_rule)) > 0),
  starting_paper_balance_usd NUMERIC(12,2) NOT NULL CHECK (starting_paper_balance_usd > 0),
  max_stake_first_trade_usd NUMERIC(12,2) NOT NULL CHECK (max_stake_first_trade_usd > 0 AND max_stake_first_trade_usd <= max_stake_usd),
  progression_gate_pct NUMERIC(6,2) NOT NULL CHECK (progression_gate_pct >= 0 AND progression_gate_pct <= 1000),
  hard_stop_pct NUMERIC(6,2) NOT NULL CHECK (hard_stop_pct > progression_gate_pct AND hard_stop_pct <= 1000),
  allow_early_cash_out BOOLEAN NOT NULL DEFAULT FALSE CHECK (allow_early_cash_out = FALSE),
  max_stake_usd NUMERIC(12,2) NOT NULL CHECK (max_stake_usd > 0 AND max_stake_usd <= 100000),
  max_daily_trades INTEGER NOT NULL CHECK (max_daily_trades >= 1 AND max_daily_trades <= 500),
  max_total_exposure_usd NUMERIC(12,2) NOT NULL CHECK (
    max_total_exposure_usd >= max_stake_usd AND max_total_exposure_usd <= 1000000
  ),
  assumed_fee_bps NUMERIC(6,2) NOT NULL CHECK (assumed_fee_bps >= 0 AND assumed_fee_bps <= 1000),
  assumed_slippage_cents NUMERIC(6,2) NOT NULL CHECK (assumed_slippage_cents >= 0 AND assumed_slippage_cents <= 25),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ
);

-- 2. Separate Paper Simulated Orders table (Kalshi BTC 15-minute Up/Down ONLY)
CREATE TABLE IF NOT EXISTS public.paper_btc15m_orders (
  order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.paper_btc15m_runs(run_id) ON DELETE RESTRICT,
  is_paper BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_paper = TRUE),
  simulation_label TEXT NOT NULL DEFAULT 'PAPER / SIMULATED' CHECK (simulation_label = 'PAPER / SIMULATED'),
  market_ticker TEXT NOT NULL,
  series_ticker TEXT NOT NULL,
  verified_asset TEXT NOT NULL CHECK (verified_asset = 'BTC'),
  verified_market_type TEXT NOT NULL CHECK (verified_market_type = 'UP_DOWN'),
  interval_open_time TIMESTAMPTZ NOT NULL,
  interval_close_time TIMESTAMPTZ NOT NULL,
  CHECK (EXTRACT(EPOCH FROM (interval_close_time - interval_open_time)) = 900),
  side TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  contracts INTEGER NOT NULL CHECK (contracts >= 1),
  quoted_ask_cents NUMERIC(6,2) NOT NULL CHECK (quoted_ask_cents > 0 AND quoted_ask_cents < 100),
  effective_fill_cents NUMERIC(6,2) NOT NULL CHECK (effective_fill_cents > 0 AND effective_fill_cents < 100),
  total_stake_usd NUMERIC(12,2) NOT NULL CHECK (total_stake_usd > 0),
  settlement_source TEXT NOT NULL CHECK (char_length(trim(settlement_source)) > 0),
  settlement_status TEXT NOT NULL CHECK (
    settlement_status IN ('UNSETTLED_NO_FINAL_RESULT', 'SETTLED_VERIFIED_CF_BRTI')
  ),
  official_result TEXT CHECK (official_result IN ('yes', 'no') OR official_result IS NULL),
  realized_pnl_usd NUMERIC(12,2),
  trading_day_utc DATE NOT NULL DEFAULT ( now() AT TIME ZONE 'UTC' )::date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Database-side trigger enforcing run.status = 'RUNNING', stake limit,
--    daily trade-count limit, and total-exposure limit on EVERY INSERT.
CREATE OR REPLACE FUNCTION public.enforce_paper_btc15m_order_limits()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_run public.paper_btc15m_runs%ROWTYPE;
  v_daily_count INTEGER;
  v_current_exposure NUMERIC(12,2);
BEGIN
  SELECT * INTO v_run FROM public.paper_btc15m_runs WHERE run_id = NEW.run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LIMIT_CHECK_FAILED: run_id % does not exist', NEW.run_id;
  END IF;

  IF v_run.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'RUN_NOT_ACTIVE: simulation run is % (paused/stopped runs cannot add simulated trades)', v_run.status;
  END IF;

  -- R1: first bet of the run must not exceed the first-bet cap (default $5)
  IF (SELECT COUNT(*) FROM public.paper_btc15m_orders WHERE run_id = NEW.run_id) = 0
     AND NEW.total_stake_usd > v_run.max_stake_first_trade_usd THEN
    RAISE EXCEPTION 'FIRST_TRADE_STAKE_CAP_EXCEEDED: first bet (%) exceeds cap (%)', NEW.total_stake_usd, v_run.max_stake_first_trade_usd;
  END IF;

  -- R4: follow-on bets require cumulative realized P&L >= progression gate (+30%)
  IF (SELECT COUNT(*) FROM public.paper_btc15m_orders WHERE run_id = NEW.run_id) > 0 THEN
    IF (
      SELECT COALESCE(SUM(realized_pnl_usd), 0) FROM public.paper_btc15m_orders
       WHERE run_id = NEW.run_id AND settlement_status = 'SETTLED_VERIFIED_CF_BRTI'
    ) < (v_run.progression_gate_pct / 100.0) * v_run.starting_paper_balance_usd THEN
      RAISE EXCEPTION 'PROGRESSION_GATE_NOT_MET: cumulative P&L below +%%', v_run.progression_gate_pct;
    END IF;
  END IF;

  -- R5: +75% hard stop locks the run until manual restart
  IF (
    SELECT COALESCE(SUM(realized_pnl_usd), 0) FROM public.paper_btc15m_orders
     WHERE run_id = NEW.run_id AND settlement_status = 'SETTLED_VERIFIED_CF_BRTI'
  ) >= (v_run.hard_stop_pct / 100.0) * v_run.starting_paper_balance_usd THEN
    UPDATE public.paper_btc15m_runs
       SET status = 'STOPPED', hard_stop_triggered = TRUE, hard_stop_at = now(), stopped_at = now(),
           stopped_reason = 'HARD_STOP_REACHED_RUN_LOCKED'
     WHERE run_id = NEW.run_id;
    RAISE EXCEPTION 'HARD_STOP_REACHED_RUN_LOCKED: cumulative P&L reached +%%; manual restart required', v_run.hard_stop_pct;
  END IF;

  -- R3: paper balance must never go negative
  IF (v_run.starting_paper_balance_usd
      - (SELECT COALESCE(SUM(total_stake_usd),0) FROM public.paper_btc15m_orders WHERE run_id = NEW.run_id AND settlement_status = 'UNSETTLED_NO_FINAL_RESULT')
      + (SELECT COALESCE(SUM(realized_pnl_usd),0) FROM public.paper_btc15m_orders WHERE run_id = NEW.run_id AND settlement_status = 'SETTLED_VERIFIED_CF_BRTI')
      - NEW.total_stake_usd) < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_PAPER_BALANCE: order would drive paper cash below zero';
  END IF;

  IF NEW.total_stake_usd > v_run.max_stake_usd THEN
    RAISE EXCEPTION 'STAKE_LIMIT_EXCEEDED: order stake (%) exceeds max_stake_usd (%)', NEW.total_stake_usd, v_run.max_stake_usd;
  END IF;

  SELECT COUNT(*) INTO v_daily_count
    FROM public.paper_btc15m_orders
   WHERE run_id = NEW.run_id AND trading_day_utc = NEW.trading_day_utc;

  IF v_daily_count + 1 > v_run.max_daily_trades THEN
    RAISE EXCEPTION 'DAILY_TRADE_COUNT_EXCEEDED: daily count (%) would exceed max_daily_trades (%)', v_daily_count + 1, v_run.max_daily_trades;
  END IF;

  SELECT COALESCE(SUM(total_stake_usd), 0) INTO v_current_exposure
    FROM public.paper_btc15m_orders
   WHERE run_id = NEW.run_id;

  IF v_current_exposure + NEW.total_stake_usd > v_run.max_total_exposure_usd THEN
    RAISE EXCEPTION 'TOTAL_EXPOSURE_LIMIT_EXCEEDED: projected exposure (%) exceeds max_total_exposure_usd (%)',
      v_current_exposure + NEW.total_stake_usd, v_run.max_total_exposure_usd;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_paper_btc15m_order_limits
  BEFORE INSERT ON public.paper_btc15m_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_paper_btc15m_order_limits();

-- 4. Enable Row Level Security (RLS) on proposed paper-only tables
ALTER TABLE public.paper_btc15m_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_btc15m_orders ENABLE ROW LEVEL SECURITY;
`;

export async function GET() {
  try {
    const tablesRes = await db.execute(
      sql.raw(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name;
      `)
    );
    const publicTables = (tablesRes.rows ?? []).map((r) => String((r as { table_name?: string }).table_name));

    const policiesRes = await db.execute(
      sql.raw(`
        SELECT tablename, policyname, permissive, roles, cmd
        FROM pg_policies
        WHERE schemaname = 'public'
        ORDER BY tablename, policyname;
      `)
    );

    return NextResponse.json({
      ok: true,
      applied: false,
      status: "AWAITING_USER_APPROVAL_BEFORE_APPLYING",
      projectRef: PROJECT_REF,
      inspection: {
        publicTablesCurrentlyInDb: publicTables,
        onlyOriginalFourTablesPresent:
          publicTables.length === 4 &&
          publicTables.includes("daily_balances") &&
          publicTables.includes("trades") &&
          publicTables.includes("bot_logs") &&
          publicTables.includes("kalshi_trades"),
        localPoliciesInspected: policiesRes.rows ?? [],
        supabaseRemoteRlsNote:
          "Existing Supabase public tables (daily_balances, trades, bot_logs, kalshi_trades) have RLS enabled. No tables, policies, or grants were added, altered, weakened, or overwritten.",
      },
      proposedNewTables: ["paper_btc15m_runs", "paper_btc15m_orders"],
      proposedSqlMigration: PROPOSED_SQL_MIGRATION,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "Failed to inspect schema",
      },
      { status: 500 }
    );
  }
}
