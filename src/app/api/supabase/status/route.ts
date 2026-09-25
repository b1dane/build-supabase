import { NextResponse } from "next/server";
import { ALLOWED_TABLES, DEFAULT_SUPABASE_URL, PROJECT_REF, redactUrlForDisplay } from "@/lib/supabase-safety";

export const dynamic = "force-dynamic";

// Reports how THIS preview is configured. Never returns any key material.
export async function GET() {
  const envUrl =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";
  const envAnon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  const serverConfigured = Boolean(envUrl && envAnon);

  return NextResponse.json({
    ok: true,
    readOnly: true,
    projectRef: PROJECT_REF,
    defaultUrl: DEFAULT_SUPABASE_URL,
    serverConfigured,
    serverHost: envUrl ? redactUrlForDisplay(envUrl) : null,
    allowedTables: [...ALLOWED_TABLES],
    writePaths: [],
    orderPlacement: {
      enabled: false,
      alpaca: false,
      kalshiOrders: false,
      brokerKeysConfigured: false,
    },
    edgeFunctions: {
      // Honest default: the user reports zero deployed functions.
      // This preview cannot call the Supabase Management API without a
      // management token (which we never request), so we report
      // "none detected per user report, not independently verified here"
      // and this app itself creates/calls zero functions.
      detected: false,
      basis: "User reports no deployed Edge Functions; this app makes zero Edge Function calls and creates none.",
      appFunctionCalls: 0,
      appFunctionsCreated: 0,
    },
    rls: {
      weakened: false,
      bypassed: false,
      note: "App never weakens or bypasses RLS. Reads use the publishable (anon) key only, so Supabase RLS policies are always enforced. If a SELECT is blocked, the UI surfaces the exact Supabase error with a retry option.",
    },
    changes: {
      supabaseTablesCreated: 0,
      supabaseTablesDropped: 0,
      policiesChanged: 0,
      functionsCreated: 0,
      note: "No Supabase schema, policy, or function changes made by this app.",
    },
    keyPolicy:
      "Browser code uses only the Supabase publishable (anon) key. service_role / db passwords / broker keys are never read, embedded, or logged. Configure server keys only via the platform secret manager — never paste secrets into chat.",
  });
}
