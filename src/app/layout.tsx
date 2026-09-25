import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pulse — Read-only Trading Monitor",
  description:
    "Read-only dashboard for Supabase tables daily_balances, trades, bot_logs, kalshi_trades. No live trading, no order placement, no secrets in browser.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#070b14] text-slate-100 antialiased">{children}</body>
    </html>
  );
}
