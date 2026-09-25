// Server-side PAPER-TRADING SIMULATOR engine & state store.
// Strictly isolated from the existing Supabase/Postgres tables:
//   daily_balances, trades, bot_logs, kalshi_trades are NEVER written to or modified.
//
// User-directed risk rules (from the user, NOT invented defaults):
//   R1. First bet must not exceed $5.
//   R2. No early cash-out at a threshold (hold to settlement); only a total loss realizes.
//   R3. Paper balance must NEVER go negative.
//   R4. Cumulative P&L of +30% unlocks the following trade.
//   R5. Cumulative P&L of +75% hard-stops the run until the user manually restarts.

import {
  KalshiMarketRaw,
  KalshiSeriesRaw,
  MarketVerificationResult,
  verifyKalshiMarket,
} from "@/lib/kalshi-btc15m-verifier";

export interface PaperUserConfig {
  configuredAt: string;
  strategyName: string;
  strategyRule: string;
  startingPaperBalanceDollars: number;
  limits: {
    maxStakeFirstTradeDollars: number; // R1
    maxStakeDollars: number;
    maxDailyTrades: number;
    maxTotalExposureDollars: number;
    progressionGatePct: number; // R4
    hardStopPct: number; // R5
    allowEarlyCashOut: boolean; // R2 (must be false)
    neverAllowNegativeBalance: true; // R3
  };
  assumptions: {
    feeRateBps: number;
    slippageCentsPerContract: number;
    note: string;
  };
  engine: {
    name: "jev-latest";
    minConviction: number; // 0..3 — default 1 (level 0 = "No signal"; engine also enforces MIN_CONVICTION_TO_TRADE=1)
    noulThreshold: 0.5; // fixed, as in the source module
    rule: string;
  };
}

export interface PaperDecisionRecord {
  decisionId: string;
  runId: string | null;
  createdAt: string;
  mode: "dry-run" | "evaluate" | "evaluate-and-trade";
  ticker: string;
  engine: "jev-latest";
  direction: "up" | "down" | "pass";
  conviction: number;
  shouldTrade: boolean;
  valid: boolean;
  reasoning: string;
  parseErrors: string[];
  rawAnswers: string;
  ruleApplied: string;
  willTrade: boolean;
  side: "yes" | "no" | null;
  sizedContracts: number | null;
  sizedStakeDollars: number | null;
  outcome: "PAPER_ORDER_RECORDED" | "NO_TRADE_SIGNAL" | "BLOCKED" | "NOT_EXECUTED" | "ENGINE_ERROR";
  outcomeCode: string;
  outcomeMessage: string;
  orderId: string | null;
  latencyMs: number | null;
  promptChars: number;
}

export type RunStatus = "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";

export interface PaperSimRun {
  runId: string;
  status: RunStatus;
  startedAt: string;
  pausedAt: string | null;
  stoppedAt: string | null;
  stoppedReason: string | null;
  hardStopTriggered: boolean;
  hardStopAt: string | null;
  manualStartConfirmed: true;
}

export interface PaperSimOrder {
  orderId: string;
  runId: string;
  createdAt: string;
  tradingDayUtc: string;
  label: "PAPER / SIMULATED — NO REAL ORDER PLACED";
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  marketTitle: string;
  intervalOpenTime: string;
  intervalCloseTime: string;
  intervalMinutes: 15;
  side: "yes" | "no";
  contracts: number;
  quotedAskCents: number;
  assumedSlippageCents: number;
  effectiveFillCents: number;
  grossCostDollars: number;
  assumedFeeDollars: number;
  totalStakeDollars: number;
  rulesPrimary: string;
  settlementSourceName: string;
  settlementStatus: "UNSETTLED_NO_FINAL_RESULT" | "SETTLED_VERIFIED_CF_BRTI";
  officialResult: "yes" | "no" | null;
  officialExpirationValue: string | null;
  settledPayoutDollars: number | null;
  realizedPnlDollars: number | null;
  settlementExplanation: string;
  earlyCashOutUsed: false; // R2: never true
  decisionId?: string; // set when the order originated from a Jev decision
}

export interface PaperAuditEntry {
  id: string;
  timestamp: string;
  category:
    | "CONFIG"
    | "RUN_CONTROL"
    | "ORDER_ACCEPTED"
    | "ORDER_REJECTED"
    | "VERIFICATION"
    | "SETTLEMENT"
    | "HARD_STOP";
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PaperSimulatorState {
  mode: "PAPER_SIMULATION_ONLY";
  liveTradingEnabled: false;
  existingTablesUntouched: true;
  config: PaperUserConfig | null;
  run: PaperSimRun | null;
  orders: PaperSimOrder[];
  decisions: PaperDecisionRecord[];
  auditLog: PaperAuditEntry[];
}

const globalForPaper = globalThis as typeof globalThis & {
  __kalshiBtc15mPaperStore?: PaperSimulatorState;
};

function createInitialState(): PaperSimulatorState {
  return {
    mode: "PAPER_SIMULATION_ONLY",
    liveTradingEnabled: false,
    existingTablesUntouched: true,
    config: null,
    run: null,
    orders: [],
    decisions: [],
    auditLog: [
      {
        id: "init-1",
        timestamp: new Date().toISOString(),
        category: "CONFIG",
        code: "AWAITING_USER_STRATEGY_AND_LIMITS",
        message:
          "Simulator initialized in locked PAPER-ONLY state. Strategy and simulated risk limits are UNSET. No run or order can occur until you configure them and manually start a run.",
      },
    ],
  };
}

export function getPaperStore(): PaperSimulatorState {
  if (!globalForPaper.__kalshiBtc15mPaperStore) {
    globalForPaper.__kalshiBtc15mPaperStore = createInitialState();
  }
  return globalForPaper.__kalshiBtc15mPaperStore;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pushAudit(store: PaperSimulatorState, entry: Omit<PaperAuditEntry, "id" | "timestamp">) {
  store.auditLog.unshift({
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (store.auditLog.length > 120) store.auditLog.length = 120;
}

export function computePaperPortfolioSummary(store: PaperSimulatorState) {
  const startingBalance = store.config?.startingPaperBalanceDollars ?? null;
  const todayUtc = new Date().toISOString().slice(0, 10);

  const todayTradeCount = store.orders.filter((o) => o.tradingDayUtc === todayUtc).length;

  const openExposureDollars = round2(
    store.orders
      .filter((o) => o.settlementStatus === "UNSETTLED_NO_FINAL_RESULT")
      .reduce((s, o) => s + o.totalStakeDollars, 0)
  );

  const cumulativeStakedDollars = round2(
    store.orders.reduce((s, o) => s + o.totalStakeDollars, 0)
  );

  const realizedPnlDollars = round2(
    store.orders
      .filter((o) => o.settlementStatus === "SETTLED_VERIFIED_CF_BRTI" && o.realizedPnlDollars !== null)
      .reduce((s, o) => s + (o.realizedPnlDollars ?? 0), 0)
  );

  const totalFeesAssumedDollars = round2(
    store.orders.reduce((s, o) => s + o.assumedFeeDollars, 0)
  );

  const availablePaperCashDollars =
    startingBalance !== null
      ? round2(Math.max(0, startingBalance - openExposureDollars + realizedPnlDollars))
      : null;

  const pnlPctOfStarting =
    startingBalance !== null && startingBalance > 0
      ? round2((realizedPnlDollars / startingBalance) * 100)
      : null;

  const cfg = store.config;
  const gateUnlocked =
    cfg !== null && pnlPctOfStarting !== null && pnlPctOfStarting >= cfg.limits.progressionGatePct;
  const hardStopReached =
    cfg !== null && pnlPctOfStarting !== null && pnlPctOfStarting >= cfg.limits.hardStopPct;

  return {
    label: "PAPER / SIMULATED BALANCES & EXPOSURE — NO REAL MONEY",
    startingPaperBalanceDollars: startingBalance,
    availablePaperCashDollars,
    openExposureDollars,
    cumulativeStakedDollars,
    realizedPnlDollars,
    pnlPctOfStartingBalance: pnlPctOfStarting,
    totalFeesAssumedDollars,
    todayTradeCount,
    totalOrdersCount: store.orders.length,
    settledOrdersCount: store.orders.filter((o) => o.settlementStatus === "SETTLED_VERIFIED_CF_BRTI").length,
    unsettledOrdersCount: store.orders.filter((o) => o.settlementStatus === "UNSETTLED_NO_FINAL_RESULT").length,
    rules: {
      firstBetCapDollars: cfg?.limits.maxStakeFirstTradeDollars ?? null,
      progressionGatePct: cfg?.limits.progressionGatePct ?? null,
      hardStopPct: cfg?.limits.hardStopPct ?? null,
      earlyCashOutAllowed: cfg?.limits.allowEarlyCashOut ?? null,
      negativeBalanceAllowed: false,
      nextTradeUnlocked: gateUnlocked,
      hardStopReached,
      blocker: hardStopReached
        ? `HARD STOP: cumulative P&L ${pnlPctOfStarting}% >= +${cfg?.limits.hardStopPct}%. Run locked until you manually restart it.`
        : !gateUnlocked
        ? `PROGRESSION GATE: next trade requires cumulative P&L >= +${cfg?.limits.progressionGatePct}% (currently ${pnlPctOfStarting ?? "n/a"}%).`
        : null,
    },
  };
}

export function configurePaperSimulator(
  input: unknown,
  targetStore: PaperSimulatorState = getPaperStore()
): { ok: true; config: PaperUserConfig } | { ok: false; code: string; message: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "INVALID_PAYLOAD", message: "Configuration payload is required." };
  }
  const body = input as Record<string, unknown>;
  const strategyName = String(body.strategyName ?? "").trim();
  const strategyRule = String(body.strategyRule ?? "").trim();

  if (!strategyName || !strategyRule) {
    pushAudit(targetStore, {
      category: "CONFIG",
      code: "STRATEGY_REQUIRED",
      message: "Rejected configuration: strategyName and strategyRule are both required.",
    });
    return {
      ok: false,
      code: "STRATEGY_REQUIRED",
      message:
        "Strategy is required before running the simulator. Provide a strategy name and an explicit entry rule.",
    };
  }

  const maxStakeFirstTradeDollars = Number(body.maxStakeFirstTradeDollars ?? body.maxStakeDollars);
  const maxStakeDollars = Number(body.maxStakeDollars);
  const maxDailyTrades = Number(body.maxDailyTrades);
  const maxTotalExposureDollars = Number(body.maxTotalExposureDollars);
  const startingPaperBalanceDollars = Number(body.startingPaperBalanceDollars ?? 100);
  const feeRateBps = Number(body.feeRateBps ?? 0);
  const slippageCentsPerContract = Number(body.slippageCentsPerContract ?? 0);
  const progressionGatePct = Number(body.progressionGatePct ?? 30);
  const hardStopPct = Number(body.hardStopPct ?? 75);
  const allowEarlyCashOut = body.allowEarlyCashOut === true;

  // R1: first-bet cap must be finite, positive, and no larger than the per-trade cap.
  if (!Number.isFinite(maxStakeFirstTradeDollars) || maxStakeFirstTradeDollars <= 0 || maxStakeFirstTradeDollars > 100_000) {
    pushAudit(targetStore, {
      category: "CONFIG",
      code: "INVALID_FIRST_BET_CAP",
      message: `Rejected configuration: first-bet cap (${String(body.maxStakeFirstTradeDollars)}) must be a finite positive number.`,
    });
    return {
      ok: false,
      code: "INVALID_FIRST_BET_CAP",
      message: "First-bet cap must be a finite number > 0 (user rule: first bet must not exceed $5).",
    };
  }

  if (!Number.isFinite(maxStakeDollars) || maxStakeDollars <= 0 || maxStakeDollars > 100_000) {
    pushAudit(targetStore, {
      category: "CONFIG",
      code: "INVALID_STAKE_LIMIT",
      message: `Rejected configuration: maxStakeDollars (${String(body.maxStakeDollars)}) must be finite > 0 (no unlimited exposure).`,
    });
    return {
      ok: false,
      code: "INVALID_STAKE_LIMIT",
      message: "maxStakeDollars must be a finite number > 0 and <= $100,000. Unlimited is rejected.",
    };
  }

  if (maxStakeFirstTradeDollars > maxStakeDollars) {
    return {
      ok: false,
      code: "INVALID_FIRST_BET_CAP",
      message: `First-bet cap ($${maxStakeFirstTradeDollars}) cannot exceed per-trade cap ($${maxStakeDollars}).`,
    };
  }

  if (!Number.isFinite(maxDailyTrades) || !Number.isInteger(maxDailyTrades) || maxDailyTrades < 1 || maxDailyTrades > 500) {
    pushAudit(targetStore, {
      category: "CONFIG",
      code: "INVALID_DAILY_TRADE_LIMIT",
      message: `Rejected configuration: maxDailyTrades (${String(body.maxDailyTrades)}) must be an integer 1..500.`,
    });
    return { ok: false, code: "INVALID_DAILY_TRADE_LIMIT", message: "maxDailyTrades must be a finite integer between 1 and 500." };
  }

  if (!Number.isFinite(maxTotalExposureDollars) || maxTotalExposureDollars <= 0 || maxTotalExposureDollars < maxStakeDollars || maxTotalExposureDollars > 1_000_000) {
    pushAudit(targetStore, {
      category: "CONFIG",
      code: "INVALID_TOTAL_EXPOSURE_LIMIT",
      message: `Rejected configuration: maxTotalExposureDollars (${String(body.maxTotalExposureDollars)}) must be finite, >= maxStake, <= $1,000,000.`,
    });
    return {
      ok: false,
      code: "INVALID_TOTAL_EXPOSURE_LIMIT",
      message: "maxTotalExposureDollars must be finite, >= maxStakeDollars, and <= $1,000,000. Unlimited exposure is forbidden.",
    };
  }

  if (!Number.isFinite(startingPaperBalanceDollars) || startingPaperBalanceDollars <= 0 || startingPaperBalanceDollars > 10_000_000) {
    return { ok: false, code: "INVALID_STARTING_BALANCE", message: "Starting paper balance must be a finite positive dollar amount." };
  }

  if (!Number.isFinite(progressionGatePct) || progressionGatePct < 0 || progressionGatePct > 1000) {
    return { ok: false, code: "INVALID_PROGRESSION_GATE", message: "Progression gate must be a finite percentage between 0 and 1000." };
  }

  if (!Number.isFinite(hardStopPct) || hardStopPct <= 0 || hardStopPct > 1000) {
    return { ok: false, code: "INVALID_HARD_STOP", message: "Hard-stop percentage must be a finite number > 0." };
  }

  if (hardStopPct <= progressionGatePct) {
    return {
      ok: false,
      code: "INVALID_HARD_STOP",
      message: `Hard stop (+${hardStopPct}%) must be greater than the progression gate (+${progressionGatePct}%), otherwise the gate could never unlock before the stop fires.`,
    };
  }

  // R2: early cash-out is forbidden by user directive — reject any config that enables it.
  if (allowEarlyCashOut) {
    pushAudit(targetStore, {
      category: "CONFIG",
      code: "EARLY_CASH_OUT_FORBIDDEN",
      message: "Rejected configuration: allowEarlyCashOut=true violates the user directive (no cash-out at thresholds; hold to settlement).",
    });
    return {
      ok: false,
      code: "EARLY_CASH_OUT_FORBIDDEN",
      message:
        "Early cash-out is disabled by your directive. The simulator holds every position to official settlement and only realizes a total loss when Kalshi publishes the final result. Set allowEarlyCashOut to false.",
    };
  }

  if (!Number.isFinite(feeRateBps) || feeRateBps < 0 || feeRateBps > 1000 || !Number.isFinite(slippageCentsPerContract) || slippageCentsPerContract < 0 || slippageCentsPerContract > 25) {
    return {
      ok: false,
      code: "INVALID_FEE_SLIPPAGE_ASSUMPTION",
      message: "Fee assumption (0–1000 bps) and slippage assumption (0–25¢/contract) must be finite non-negative numbers.",
    };
  }

  const minConviction = Number(body.minConviction ?? 1);
  if (!Number.isInteger(minConviction) || minConviction < 0 || minConviction > 3) {
    return {
      ok: false,
      code: "INVALID_MIN_CONVICTION",
      message: "minConviction must be an integer from 0 to 3 (engine enforces a floor of 1 = weak signal; 0 = no signal and never trades).",
    };
  }

  const config: PaperUserConfig = {
    configuredAt: new Date().toISOString(),
    strategyName,
    strategyRule,
    startingPaperBalanceDollars: round2(startingPaperBalanceDollars),
    limits: {
      maxStakeFirstTradeDollars: round2(maxStakeFirstTradeDollars),
      maxStakeDollars: round2(maxStakeDollars),
      maxDailyTrades,
      maxTotalExposureDollars: round2(maxTotalExposureDollars),
      progressionGatePct: round2(progressionGatePct),
      hardStopPct: round2(hardStopPct),
      allowEarlyCashOut: false,
      neverAllowNegativeBalance: true,
    },
    assumptions: {
      feeRateBps: round2(feeRateBps),
      slippageCentsPerContract: round2(slippageCentsPerContract),
      note: `PAPER / SIMULATED assumptions: +${round2(slippageCentsPerContract)}¢/contract adverse slippage on the quoted ask, plus ${round2(feeRateBps)} bps (${(feeRateBps / 100).toFixed(2)}%) simulated fee on gross notional. No early cash-out: positions hold to official CF Benchmarks BRTI settlement.`,
    },
    engine: {
      name: "jev-latest",
      minConviction,
      noulThreshold: 0.5,
      rule: `Jev batched decision: trade iff should_trade (noul > 0.5) AND direction in {up, down} AND conviction >= ${minConviction}; up -> PAPER YES, down -> PAPER NO; size = max contracts permitted by caps (first bet <= $${round2(maxStakeFirstTradeDollars)}, then <= $${round2(maxStakeDollars)}), never below $0 cash.`,
    },
  };

  targetStore.config = config;
  pushAudit(targetStore, {
    category: "CONFIG",
    code: "CONFIG_SAVED",
    message: `Configured strategy "${config.strategyName}". User directives enforced: first bet <= $${config.limits.maxStakeFirstTradeDollars}, progression gate +${config.limits.progressionGatePct}%, hard stop +${config.limits.hardStopPct}% (manual restart required), early cash-out DISABLED, negative balance FORBIDDEN. Manual run start still required.`,
  });

  return { ok: true, config };
}

function freshRun(): PaperSimRun {
  return {
    runId: `paper-run-${Date.now()}`,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    pausedAt: null,
    stoppedAt: null,
    stoppedReason: null,
    hardStopTriggered: false,
    hardStopAt: null,
    manualStartConfirmed: true,
  };
}

export function controlPaperRun(
  actionRaw: unknown,
  targetStore: PaperSimulatorState = getPaperStore()
): { ok: true; run: PaperSimRun | null } | { ok: false; code: string; message: string } {
  const action = String(actionRaw ?? "").toLowerCase();

  if (action === "reset") {
    targetStore.run = null;
    targetStore.orders = [];
    targetStore.decisions = [];
    pushAudit(targetStore, {
      category: "RUN_CONTROL",
      code: "RUN_RESET",
      message: "Paper run and paper orders cleared. Strategy & limits retained.",
    });
    return { ok: true, run: null };
  }

  if (!targetStore.config) {
    pushAudit(targetStore, {
      category: "RUN_CONTROL",
      code: "LIMITS_OR_STRATEGY_UNSET",
      message: `Rejected run action "${action}": strategy and risk limits must be configured first.`,
    });
    return {
      ok: false,
      code: "LIMITS_OR_STRATEGY_UNSET",
      message: "Configure a strategy and all risk limits before starting or controlling a run.",
    };
  }

  if (action === "start") {
    // Manual restart after a hard stop is explicitly allowed — that is the user's rule.
    const prev = targetStore.run;
    if (prev?.hardStopTriggered) {
      pushAudit(targetStore, {
        category: "RUN_CONTROL",
        code: "RUN_MANUALLY_RESTARTED_AFTER_HARD_STOP",
        message: `User manually restarted after hard stop on run ${prev.runId}. A fresh run begins at the current P&L basis.`,
      });
    }
    targetStore.run = freshRun();
    pushAudit(targetStore, {
      category: "RUN_CONTROL",
      code: "RUN_MANUALLY_STARTED",
      message: `Simulation run ${targetStore.run.runId} manually started by user.`,
    });
    return { ok: true, run: targetStore.run };
  }

  if (!targetStore.run) {
    return { ok: false, code: "NO_ACTIVE_RUN", message: "No simulation run exists yet. Use 'Manual Start Run' first." };
  }

  if (action === "pause") {
    targetStore.run.status = "PAUSED";
    targetStore.run.pausedAt = new Date().toISOString();
    pushAudit(targetStore, {
      category: "RUN_CONTROL",
      code: "RUN_PAUSED",
      message: `Run ${targetStore.run.runId} PAUSED. All further simulation writes are blocked.`,
    });
    return { ok: true, run: targetStore.run };
  }

  if (action === "resume") {
    if (targetStore.run.status === "STOPPED") {
      return { ok: false, code: "RUN_ALREADY_STOPPED", message: "A stopped run cannot be resumed; manually start a new run." };
    }
    targetStore.run.status = "RUNNING";
    targetStore.run.pausedAt = null;
    pushAudit(targetStore, { category: "RUN_CONTROL", code: "RUN_RESUMED", message: `Run ${targetStore.run.runId} manually resumed.` });
    return { ok: true, run: targetStore.run };
  }

  if (action === "stop") {
    targetStore.run.status = "STOPPED";
    targetStore.run.stoppedAt = new Date().toISOString();
    targetStore.run.stoppedReason = "Manual stop by user.";
    pushAudit(targetStore, {
      category: "RUN_CONTROL",
      code: "RUN_STOPPED",
      message: `Run ${targetStore.run.runId} STOPPED. All further simulation writes are blocked.`,
    });
    return { ok: true, run: targetStore.run };
  }

  return { ok: false, code: "UNKNOWN_RUN_ACTION", message: `Unsupported run action "${action}". Allowed: start, pause, resume, stop, reset.` };
}

export interface SubmitPaperOrderInput {
  market: KalshiMarketRaw;
  series?: KalshiSeriesRaw | null;
  side: "yes" | "no";
  contracts: number;
  overrideAskCents?: number;
}

export function submitPaperOrder(
  input: SubmitPaperOrderInput,
  targetStore: PaperSimulatorState = getPaperStore()
):
  | { ok: true; order: PaperSimOrder; verification: MarketVerificationResult }
  | { ok: false; code: string; message: string; verification?: MarketVerificationResult } {
  // 1. Strategy + limits must be set and verifiable
  const cfg = targetStore.config;
  if (
    !cfg ||
    !cfg.strategyName ||
    !cfg.strategyRule ||
    !Number.isFinite(cfg.limits.maxStakeDollars) ||
    cfg.limits.maxStakeDollars <= 0 ||
    !Number.isFinite(cfg.limits.maxDailyTrades) ||
    cfg.limits.maxDailyTrades < 1 ||
    !Number.isFinite(cfg.limits.maxTotalExposureDollars) ||
    cfg.limits.maxTotalExposureDollars <= 0
  ) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "LIMITS_OR_STRATEGY_UNSET",
      message: "Rejected simulated order: strategy or risk limits are unset or invalid.",
    });
    return {
      ok: false,
      code: "LIMITS_OR_STRATEGY_UNSET",
      message: "Write rejected: strategy and risk limits must be configured before any simulated trade.",
    };
  }

  // 2. Run must be manually started and RUNNING
  if (!targetStore.run || targetStore.run.status !== "RUNNING") {
    const currentStatus = targetStore.run?.status ?? "IDLE_NOT_STARTED";
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: `RUN_${currentStatus}`,
      message: `Rejected simulated order on "${input.market?.ticker ?? "unknown"}": run status is ${currentStatus}.`,
    });
    return {
      ok: false,
      code: `RUN_${currentStatus}`,
      message: `Write rejected: simulation run is ${currentStatus}. Paused/stopped runs cannot add simulated trades.`,
    };
  }

  // 3. Strict BTC 15-minute Up/Down market verification
  const verification = verifyKalshiMarket(input.market, input.series);
  if (!verification.inScope) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "MARKET_OUT_OF_SCOPE",
      message: `Rejected out-of-scope market "${verification.ticker || "unknown"}": ${verification.exclusionReasons.join(" | ")}`,
      details: { exclusionReasons: verification.exclusionReasons },
    });
    return {
      ok: false,
      code: "MARKET_OUT_OF_SCOPE",
      message: `Market "${verification.ticker || "unknown"}" excluded: ${verification.exclusionReasons.join(" ")}`,
      verification,
    };
  }

  // 4. Side + contracts validation
  const side = input.side === "yes" ? "yes" : input.side === "no" ? "no" : null;
  const contracts = Number(input.contracts);
  if (!side || !Number.isInteger(contracts) || contracts < 1 || contracts > 100_000) {
    return { ok: false, code: "INVALID_ORDER_PARAMS", message: "Side must be 'yes' or 'no' and contracts must be an integer >= 1." };
  }

  // 5. Price / stake computation with stated assumptions
  const rawMarketAskCents = side === "yes" ? verification.yesAskCents : verification.noAskCents;
  const fallbackLastCents = verification.lastPriceCents;
  let quotedAskCents =
    typeof input.overrideAskCents === "number" && Number.isFinite(input.overrideAskCents)
      ? input.overrideAskCents
      : rawMarketAskCents && rawMarketAskCents > 0 && rawMarketAskCents < 100
      ? rawMarketAskCents
      : fallbackLastCents && fallbackLastCents > 0 && fallbackLastCents < 100
      ? fallbackLastCents
      : 50;
  quotedAskCents = Math.min(Math.max(quotedAskCents, 1), 99);

  const assumedSlippageCents = cfg.assumptions.slippageCentsPerContract;
  const effectiveFillCents = Math.min(99.9, round2(quotedAskCents + assumedSlippageCents));
  const grossCostDollars = round2((effectiveFillCents / 100) * contracts);
  const assumedFeeDollars = round2(grossCostDollars * (cfg.assumptions.feeRateBps / 10_000));
  const totalStakeDollars = round2(grossCostDollars + assumedFeeDollars);

  const summary = computePaperPortfolioSummary(targetStore);

  // 6. R5 — hard stop on +75% P&L: lock the run until manual restart
  if (summary.rules.hardStopReached) {
    targetStore.run.status = "STOPPED";
    targetStore.run.stoppedAt = new Date().toISOString();
    targetStore.run.hardStopTriggered = true;
    targetStore.run.hardStopAt = new Date().toISOString();
    targetStore.run.stoppedReason = `HARD STOP: cumulative P&L ${summary.pnlPctOfStartingBalance}% reached +${cfg.limits.hardStopPct}%. Run locked until user manually restarts.`;
    pushAudit(targetStore, {
      category: "HARD_STOP",
      code: "HARD_STOP_REACHED_RUN_LOCKED",
      message: targetStore.run.stoppedReason,
      details: { realizedPnlDollars: summary.realizedPnlDollars, pnlPct: summary.pnlPctOfStartingBalance },
    });
    return {
      ok: false,
      code: "HARD_STOP_REACHED_RUN_LOCKED",
      message: `Write rejected and run STOPPED: cumulative paper P&L of ${summary.pnlPctOfStartingBalance}% reached your +${cfg.limits.hardStopPct}% hard-stop threshold. The run stays locked until you manually restart it.`,
      verification,
    };
  }

  // 7. R1 — first bet of the run must not exceed the first-bet cap ($5)
  const isFirstChildOfRun = targetStore.orders.length === 0;
  if (isFirstChildOfRun && totalStakeDollars > cfg.limits.maxStakeFirstTradeDollars) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "FIRST_TRADE_STAKE_CAP_EXCEEDED",
      message: `Rejected first simulated bet of $${totalStakeDollars.toFixed(2)}: exceeds first-bet cap of $${cfg.limits.maxStakeFirstTradeDollars.toFixed(2)}.`,
    });
    return {
      ok: false,
      code: "FIRST_TRADE_STAKE_CAP_EXCEEDED",
      message: `Write rejected: this is the first bet of the run and its stake of $${totalStakeDollars.toFixed(2)} exceeds your first-bet cap of $${cfg.limits.maxStakeFirstTradeDollars.toFixed(2)}.`,
      verification,
    };
  }

  // 8. R4 — subsequent bets require cumulative P&L >= +30%
  if (!isFirstChildOfRun && !summary.rules.nextTradeUnlocked) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "PROGRESSION_GATE_NOT_MET",
      message: `Rejected follow-on simulated bet: cumulative P&L ${summary.pnlPctOfStartingBalance}% is below the +${cfg.limits.progressionGatePct}% progression gate.`,
    });
    return {
      ok: false,
      code: "PROGRESSION_GATE_NOT_MET",
      message: `Write rejected: your progression gate requires cumulative paper P&L of at least +${cfg.limits.progressionGatePct}% before the next trade. Current P&L is ${summary.pnlPctOfStartingBalance}% ($${summary.realizedPnlDollars.toFixed(2)}).`,
      verification,
    };
  }

  // 9. Per-trade stake cap
  if (totalStakeDollars > cfg.limits.maxStakeDollars) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "STAKE_LIMIT_EXCEEDED",
      message: `Rejected simulated order ($${totalStakeDollars.toFixed(2)}): exceeds maxStakeDollars $${cfg.limits.maxStakeDollars.toFixed(2)}.`,
    });
    return {
      ok: false,
      code: "STAKE_LIMIT_EXCEEDED",
      message: `Write rejected: stake $${totalStakeDollars.toFixed(2)} exceeds the configured per-trade cap of $${cfg.limits.maxStakeDollars.toFixed(2)}.`,
      verification,
    };
  }

  // 10. Daily trade-count cap
  if (summary.todayTradeCount + 1 > cfg.limits.maxDailyTrades) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "DAILY_TRADE_COUNT_EXCEEDED",
      message: `Rejected simulated order: daily count (${summary.todayTradeCount}) reached maxDailyTrades (${cfg.limits.maxDailyTrades}).`,
    });
    return {
      ok: false,
      code: "DAILY_TRADE_COUNT_EXCEEDED",
      message: `Write rejected: daily simulated trade count ${summary.todayTradeCount}/${cfg.limits.maxDailyTrades} would exceed your limit.`,
      verification,
    };
  }

  // 11. Total exposure cap
  const projectedExposure = round2(summary.cumulativeStakedDollars + totalStakeDollars);
  if (projectedExposure > cfg.limits.maxTotalExposureDollars) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "TOTAL_EXPOSURE_LIMIT_EXCEEDED",
      message: `Rejected simulated order: projected exposure $${projectedExposure.toFixed(2)} exceeds maxTotalExposureDollars $${cfg.limits.maxTotalExposureDollars.toFixed(2)}.`,
    });
    return {
      ok: false,
      code: "TOTAL_EXPOSURE_LIMIT_EXCEEDED",
      message: `Write rejected: projected total simulated exposure $${projectedExposure.toFixed(2)} exceeds your cap of $${cfg.limits.maxTotalExposureDollars.toFixed(2)}.`,
      verification,
    };
  }

  // 12. R3 — paper balance must never go negative
  if (summary.availablePaperCashDollars !== null && round2(summary.availablePaperCashDollars - totalStakeDollars) < 0) {
    pushAudit(targetStore, {
      category: "ORDER_REJECTED",
      code: "INSUFFICIENT_PAPER_BALANCE",
      message: `Rejected simulated order: stake $${totalStakeDollars.toFixed(2)} would push paper cash negative (available $${summary.availablePaperCashDollars.toFixed(2)}).`,
    });
    return {
      ok: false,
      code: "INSUFFICIENT_PAPER_BALANCE",
      message: `Write rejected: stake $${totalStakeDollars.toFixed(2)} would drive paper cash below $0 (available $${summary.availablePaperCashDollars.toFixed(2)}). Negative balances are forbidden.`,
      verification,
    };
  }

  // 13. R2 — outcome only from verified official settlement; never an invented result
  const canSettle = verification.settlement.canClaimFinalOutcome;
  const officialResult = verification.settlement.officialResult;
  const settledPayoutDollars = canSettle && officialResult ? round2(officialResult === side ? contracts * 1.0 : 0) : null;
  const realizedPnlDollars = settledPayoutDollars !== null ? round2(settledPayoutDollars - totalStakeDollars) : null;

  const order: PaperSimOrder = {
    orderId: `paper-ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    runId: targetStore.run.runId,
    createdAt: new Date().toISOString(),
    tradingDayUtc: new Date().toISOString().slice(0, 10),
    label: "PAPER / SIMULATED — NO REAL ORDER PLACED",
    ticker: verification.ticker,
    eventTicker: verification.eventTicker,
    seriesTicker: verification.seriesTicker,
    marketTitle: verification.title,
    intervalOpenTime: verification.openTime ?? "",
    intervalCloseTime: verification.closeTime ?? "",
    intervalMinutes: 15,
    side,
    contracts,
    quotedAskCents,
    assumedSlippageCents,
    effectiveFillCents,
    grossCostDollars,
    assumedFeeDollars,
    totalStakeDollars,
    rulesPrimary: verification.rulesPrimary,
    settlementSourceName:
      verification.settlementSources.map((s) => s.name).filter(Boolean).join(", ") || "CF Benchmarks BRTI",
    settlementStatus: canSettle ? "SETTLED_VERIFIED_CF_BRTI" : "UNSETTLED_NO_FINAL_RESULT",
    officialResult,
    officialExpirationValue: verification.settlement.officialExpirationValue,
    settledPayoutDollars,
    realizedPnlDollars,
    settlementExplanation: verification.settlement.explanation,
    earlyCashOutUsed: false,
  };

  targetStore.orders.unshift(order);
  pushAudit(targetStore, {
    category: "ORDER_ACCEPTED",
    code: "PAPER_ORDER_RECORDED",
    message: `Recorded PAPER ${side.toUpperCase()} x${contracts} on verified BTC 15m market ${order.ticker} @ ${effectiveFillCents}¢ (stake $${totalStakeDollars.toFixed(2)}). Settlement: ${order.settlementStatus}. No early cash-out.`,
  });

  return { ok: true, order, verification };
}

// Re-check open paper orders against live Kalshi settlement data (official results only).
export async function settleOpenPaperOrders(
  targetStore: PaperSimulatorState = getPaperStore()
): Promise<{ updated: number; stillUnsettled: number; hardStopTriggered: boolean }> {
  const { discoverLiveKalshiBtc15mMarkets } = await import("@/lib/kalshi-btc15m-verifier");
  const report = await discoverLiveKalshiBtc15mMarkets();
  const byTicker = new Map(report.verifiedMarkets.map((m) => [m.ticker, m]));

  let updated = 0;
  let stillUnsettled = 0;

  for (const order of targetStore.orders) {
    if (order.settlementStatus === "SETTLED_VERIFIED_CF_BRTI") continue;
    const live = byTicker.get(order.ticker);
    if (!live) {
      stillUnsettled++;
      continue;
    }
    if (!live.settlement.canClaimFinalOutcome) {
      stillUnsettled++;
      continue;
    }
    const result = live.settlement.officialResult;
    order.officialResult = result;
    order.officialExpirationValue = live.settlement.officialExpirationValue;
    order.settlementStatus = "SETTLED_VERIFIED_CF_BRTI";
    order.settledPayoutDollars = result === order.side ? round2(order.contracts * 1.0) : 0;
    order.realizedPnlDollars = round2(order.settledPayoutDollars - order.totalStakeDollars);
    order.settlementExplanation = live.settlement.explanation;
    updated++;
    pushAudit(targetStore, {
      category: "SETTLEMENT",
      code: "PAPER_ORDER_SETTLED_OFFICIAL",
      message: `${order.ticker} settled officially ${String(result).toUpperCase()} at BRTI ${String(order.officialExpirationValue)}. PAPER ${order.side.toUpperCase()} x${order.contracts} payout $${order.settledPayoutDollars.toFixed(2)}, P&L $${order.realizedPnlDollars.toFixed(2)}.`,
    });
  }

  // Re-evaluate the hard stop after settlement
  const summary = computePaperPortfolioSummary(targetStore);
  let hardStopTriggered = false;
  if (summary.rules.hardStopReached && targetStore.run?.status === "RUNNING") {
    targetStore.run.status = "STOPPED";
    targetStore.run.hardStopTriggered = true;
    targetStore.run.hardStopAt = new Date().toISOString();
    targetStore.run.stoppedAt = new Date().toISOString();
    targetStore.run.stoppedReason = `HARD STOP: cumulative P&L ${summary.pnlPctOfStartingBalance}% reached +${targetStore.config?.limits.hardStopPct}%. Run locked until user manually restarts.`;
    hardStopTriggered = true;
    pushAudit(targetStore, {
      category: "HARD_STOP",
      code: "HARD_STOP_REACHED_RUN_LOCKED",
      message: targetStore.run.stoppedReason,
    });
  }

  return { updated, stillUnsettled, hardStopTriggered };
}

export function createIsolatedTestStore(): PaperSimulatorState {
  return createInitialState();
}

// ── Strategy-engine helpers ─────────────────────────────────────────────────

export function recordDecision(rec: PaperDecisionRecord, targetStore: PaperSimulatorState = getPaperStore()) {
  targetStore.decisions.unshift(rec);
  if (targetStore.decisions.length > 100) targetStore.decisions.length = 100;
  pushAudit(targetStore, {
    category: "VERIFICATION",
    code: `JEV_${rec.outcome}`,
    message: `Jev ${rec.mode} on ${rec.ticker}: ${rec.direction.toUpperCase()} conviction=${rec.conviction} should_trade=${rec.shouldTrade} -> ${rec.outcome}${rec.outcomeCode ? ` (${rec.outcomeCode})` : ""}${rec.orderId ? ` order ${rec.orderId}` : ""}.`,
  });
}

// Size a paper order to the maximum the caps permit, so a genuine signal is never
// rejected merely for arbitrary sizing. Returns contracts >= 1 or a precise reason.
export function computeAutoSize(
  verification: MarketVerificationResult,
  side: "yes" | "no",
  targetStore: PaperSimulatorState = getPaperStore()
):
  | { ok: true; contracts: number; askCents: number; estStakeDollars: number; capLabel: string; capDollars: number }
  | { ok: false; code: string; message: string } {
  const cfg = targetStore.config;
  if (!cfg) return { ok: false, code: "LIMITS_OR_STRATEGY_UNSET", message: "Configure strategy and limits first." };

  const rawAsk = side === "yes" ? verification.yesAskCents : verification.noAskCents;
  const askCents =
    rawAsk && rawAsk > 0 && rawAsk < 100
      ? rawAsk
      : verification.lastPriceCents && verification.lastPriceCents > 0 && verification.lastPriceCents < 100
      ? side === "yes"
        ? verification.lastPriceCents
        : 100 - verification.lastPriceCents
      : null;
  if (askCents === null) {
    return { ok: false, code: "NO_QUOTE", message: `No usable ${side.toUpperCase()} ask on ${verification.ticker}; refusing to size against an invented price.` };
  }

  const summary = computePaperPortfolioSummary(targetStore);
  const isFirst = targetStore.orders.length === 0;
  const caps: Array<{ label: string; dollars: number }> = [
    { label: isFirst ? "first-bet cap" : "per-trade cap", dollars: isFirst ? Math.min(cfg.limits.maxStakeFirstTradeDollars, cfg.limits.maxStakeDollars) : cfg.limits.maxStakeDollars },
    { label: "remaining total exposure", dollars: round2(cfg.limits.maxTotalExposureDollars - summary.cumulativeStakedDollars) },
    { label: "available paper cash", dollars: summary.availablePaperCashDollars ?? 0 },
  ];
  const binding = caps.reduce((a, b) => (b.dollars < a.dollars ? b : a));
  const perContract = ((askCents + cfg.assumptions.slippageCentsPerContract) / 100) * (1 + cfg.assumptions.feeRateBps / 10_000);
  const contracts = Math.floor(binding.dollars / perContract);
  if (contracts < 1) {
    return {
      ok: false,
      code: "CANNOT_SIZE_WITHIN_CAPS",
      message: `Even 1 contract at ${askCents}¢ (+slippage/fee = $${perContract.toFixed(4)}) exceeds the binding cap "${binding.label}" of $${binding.dollars.toFixed(2)}. No order sized.`,
    };
  }
  return { ok: true, contracts, askCents, estStakeDollars: round2(contracts * perContract), capLabel: binding.label, capDollars: binding.dollars };
}
