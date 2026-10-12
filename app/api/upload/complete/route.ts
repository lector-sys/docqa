import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { requestSessionId } from "@/lib/session";

export const runtime = "nodejs";

function bad(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Step 2 of upload: the bytes are in storage, so record the document as `pending`
 * for the worker to pick up. Writing the row only after the object exists means the
 * worker never sees a document whose file was never finished.
 */
export async function POST(req: Request) {
  const sessionId = requestSessionId(req);
  if (!sessionId) return bad("Missing session. Reload the page and try again.", 400);

  let body: { docId?: unknown; filename?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("Malformed request.", 400);
  }

  const { docId, filename } = body;
  if (typeof docId !== "string" || typeof filename !== "string" || !filename.trim()) {
    return bad("Malformed request.", 400);
  }

  // Path is derived here, never taken from the client, so one session cannot claim
  // another session's uploaded object.
  const path = `${sessionId}/${docId}.pdf`;
  const db = supabaseAdmin();

  const { data: found, error: listError } = await db.storage
    .from("pdfs")
    .list(sessionId, { search: `${docId}.pdf`, limit: 1 });

  if (listError) {
    console.error("upload/complete: storage list failed", listError);
    return bad("Couldn't confirm the upload. Please try again.", 500);
  }
  if (!found?.length) {
    return bad("The upload didn't finish. Please try again.", 409);
  }

  const { data, error } = await db
    .from("documents")
    .insert({ id: docId, filename, storage_path: path, session_id: sessionId, status: "pending" })
    .select("id, filename, status")
    .single();

  if (error) {
    console.error("upload/complete: insert failed", error);
    await db.storage.from("pdfs").remove([path]);
    return bad("Couldn't save the document. Please try again.", 500);
  }

  return NextResponse.json(data);
}
