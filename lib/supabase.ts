import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Env vars must be read as literal `process.env.NAME` expressions.
 *
 * There is no `process` object in the browser — the bundler substitutes each *static*
 * `process.env.NEXT_PUBLIC_X` it can see at build time. A computed lookup like
 * `process.env[name]` cannot be substituted, so it silently yields undefined in client code
 * while continuing to work on the server. Passing the value in keeps the check reusable
 * without hiding the read.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing env var ${name}. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

/** Server-only client (service role, bypasses RLS). Never import from a client component. */
export function supabaseAdmin(): SupabaseClient {
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
    { auth: { persistSession: false } },
  );
}

let browserClient: SupabaseClient | null = null;

/** Browser client (anon key, read-only under RLS, scoped by the session header). */
export function supabaseBrowser(sessionId: string): SupabaseClient {
  browserClient ??= createClient(
    required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      auth: { persistSession: false },
      global: { headers: { "x-session-id": sessionId } },
    },
  );
  return browserClient;
}
