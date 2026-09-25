import { NextResponse } from "next/server";
import { isAllowedTable, sanitizeLimit } from "@/lib/supabase-safety";

export const dynamic = "force-dynamic";

// Read-only proxy. GET only, allowlisted tables only, SELECT only.
// Uses server-side env keys (anon/publishable) when configured so the browser
// never needs a secret. Never accepts or forwards service_role.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const table = url.searchParams.get("table") ?? "";
  const limit = sanitizeLimit(url.searchParams.get("limit"), 50);
  const offsetRaw = url.searchParams.get("offset") ?? "0";
  const offset = Math.max(0, parseInt(offsetRaw, 10) || 0);
  const order = url.searchParams.get("order") ?? "";

  if (!isAllowedTable(table)) {
    return NextResponse.json(
      {
        ok: false,
        code: "TABLE_NOT_ALLOWED",
        message: `Table "${table}" is not in the read-only allowlist. Allowed: daily_balances, trades, bot_logs, kalshi_trades.`,
        allowed: ["daily_balances", "trades", "bot_logs", "kalshi_trades"],
      },
      { status: 400 }
    );
  }

  const base =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  if (!base || !anon) {
    return NextResponse.json(
      {
        ok: false,
        code: "NOT_CONFIGURED",
        message:
          "Server-side Supabase credentials are not configured in this preview (SUPABASE_URL / SUPABASE_ANON_KEY missing). Use the dashboard's browser connection form with your publishable key, or configure secrets via the platform secret manager. No data was fetched.",
        table,
      },
      { status: 428 }
    );
  }

  // Guard: refuse to use anything that looks like a service_role key.
  // Heuristic: service_role JWTs contain `"role":"service_role"`. We decode
  // the payload without verifying (read-only guard, not auth).
  try {
    const parts = anon.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
      );
      if (payload?.role === "service_role") {
        return NextResponse.json(
          {
            ok: false,
            code: "REFUSED_SERVICE_ROLE",
            message:
              "Refusing to query with a service_role key. This dashboard is read-only and only ever uses the publishable (anon) key so RLS stays enforced.",
          },
          { status: 403 }
        );
      }
    }
  } catch {
    // If the key isn't a JWT (e.g. sb_publishable_...), continue — it's still
    // only ever used for GET reads.
  }

  let rest = `${base.replace(/\/$/, "")}/rest/v1/${table}?select=*&limit=${limit}&offset=${offset}`;
  // Allow ordering only on common timestamp-ish columns to stay read-only.
  const orderMatch = order.match(/^([a-z_]+)\.(asc|desc)$/i);
  if (orderMatch) {
    const col = orderMatch[1].toLowerCase();
    const dir = orderMatch[2].toLowerCase();
    if (["created_at", "executed_at", "logged_at", "balance_date", "id", "date"].includes(col)) {
      rest += `&order=${encodeURIComponent(col)}.${dir}`;
    }
  } else {
    // sensible defaults per table
    if (table === "daily_balances") rest += `&order=balance_date.desc.nullslast&order=id.desc`;
    else if (table === "bot_logs") rest += `&order=created_at.desc.nullslast&order=id.desc`;
    else rest += `&order=created_at.desc.nullslast&order=id.desc`;
  }

  try {
    const r = await fetch(rest, {
      method: "GET",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    const text = await r.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "SUPABASE_ERROR",
          message: `Supabase REST returned ${r.status}. ${typeof data === "object" && data !== null && "message" in data ? String((data as { message: unknown }).message) : text.slice(0, 500)}`,
          status: r.status,
          table,
          hint:
            r.status === 401 || r.status === 403
              ? "This usually means RLS blocked the anon read or the publishable key is wrong. The app did not weaken RLS — check the table's SELECT policies for the anon role."
              : undefined,
        },
        { status: 502 }
      );
    }
    const rows = Array.isArray(data) ? data : [];
    return NextResponse.json({ ok: true, table, rows, count: rows.length, via: "server-proxy" });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "FETCH_FAILED",
        message: e instanceof Error ? e.message : "Network fetch to Supabase failed.",
        table,
      },
      { status: 502 }
    );
  }
}

// Explicitly reject writes at the HTTP layer.
export async function POST() {
  return NextResponse.json(
    { ok: false, code: "READ_ONLY", message: "This API is read-only. POST is rejected." },
    { status: 405 }
  );
}
export async function PUT() {
  return NextResponse.json(
    { ok: false, code: "READ_ONLY", message: "This API is read-only. PUT is rejected." },
    { status: 405 }
  );
}
export async function PATCH() {
  return NextResponse.json(
    { ok: false, code: "READ_ONLY", message: "This API is read-only. PATCH is rejected." },
    { status: 405 }
  );
}
export async function DELETE() {
  return NextResponse.json(
    { ok: false, code: "READ_ONLY", message: "This API is read-only. DELETE is rejected." },
    { status: 405 }
  );
}
