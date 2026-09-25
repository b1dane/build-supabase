// Local mirror of the existing Supabase public tables.
// READ-ONLY INTENT: this app never writes to Supabase. These tables exist only
// so `drizzle-kit push` succeeds locally and so we can report local row counts
// as proof that we did not drop / truncate / overwrite anything.
// Do NOT add broker keys, secrets, or order-placement columns here.

import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
  date,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

export const dailyBalances = pgTable("daily_balances", {
  id: serial("id").primaryKey(),
  balanceDate: date("balance_date"),
  balance: numeric("balance", { precision: 18, scale: 2 }),
  equity: numeric("equity", { precision: 18, scale: 2 }),
  currency: text("currency").default("USD"),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  raw: jsonb("raw"),
});

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  symbol: text("symbol"),
  side: text("side"),
  quantity: numeric("quantity", { precision: 18, scale: 8 }),
  price: numeric("price", { precision: 18, scale: 8 }),
  proceeds: numeric("proceeds", { precision: 18, scale: 2 }),
  pnl: numeric("pnl", { precision: 18, scale: 2 }),
  status: text("status"),
  broker: text("broker"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  raw: jsonb("raw"),
});

export const botLogs = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  loggedAt: timestamp("logged_at", { withTimezone: true }),
  level: text("level"),
  botName: text("bot_name"),
  message: text("message"),
  context: jsonb("context"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const kalshiTrades = pgTable("kalshi_trades", {
  id: serial("id").primaryKey(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  ticker: text("ticker"),
  marketTitle: text("market_title"),
  side: text("side"),
  count: integer("count"),
  price: numeric("price", { precision: 18, scale: 4 }),
  action: text("action"),
  status: text("status"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  raw: jsonb("raw"),
});
