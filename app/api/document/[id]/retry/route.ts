import { NextResponse } from "next/server";
import { requestSessionId } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

/**
 * Put a failed document back in the queue. The worker deletes any existing chunks when it
 * claims a document, so a retry is a clean reprocess rather than a resume.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionId = requestSessionId(req);
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session. Reload the page." }, { status: 400 });
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, status, is_demo, session_id")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("retry: lookup failed", error);
    return NextResponse.json({ error: "Couldn't retry this document." }, { status: 500 });
  }
  if (!doc || !(doc.is_demo || doc.session_id === sessionId)) {
    return NextResponse.json({ error: "That document isn't available." }, { status: 404 });
  }
  if (doc.status !== "failed") {
    return NextResponse.json({ error: "That document isn't in a failed state." }, { status: 409 });
  }

  const { error: updateError } = await db
    .from("documents")
    .update({ status: "pending", error_message: null, chunks_done: 0, chunks_total: 0 })
    .eq("id", id)
    .eq("status", "failed");

  if (updateError) {
    console.error("retry: update failed", updateError);
    return NextResponse.json({ error: "Couldn't retry this document." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
