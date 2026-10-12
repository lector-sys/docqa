import { NextResponse } from "next/server";
import { requestSessionId } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

/** Long enough to read a document without re-fetching, short enough that a leaked link dies. */
const EXPIRES_IN_SECONDS = 30 * 60;

/**
 * A short-lived signed URL for the raw PDF. The bucket stays private: the browser never holds
 * credentials for it, only a link scoped to one object that expires on its own.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = requestSessionId(req);
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session. Reload the page." }, { status: 400 });
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: doc, error } = await db
    .from("documents")
    .select("storage_path, is_demo, session_id")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("document url: lookup failed", error);
    return NextResponse.json({ error: "Couldn't open this document." }, { status: 500 });
  }
  // Missing and not-yours look identical from outside.
  if (!doc || !(doc.is_demo || doc.session_id === sessionId)) {
    return NextResponse.json({ error: "That document isn't available." }, { status: 404 });
  }

  const { data: signed, error: signError } = await db.storage
    .from("pdfs")
    .createSignedUrl(doc.storage_path, EXPIRES_IN_SECONDS);

  if (signError || !signed) {
    console.error("document url: signing failed", signError);
    return NextResponse.json({ error: "Couldn't open this document." }, { status: 500 });
  }

  return NextResponse.json({ url: signed.signedUrl }, { headers: { "cache-control": "no-store" } });
}
