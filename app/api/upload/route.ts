import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { requestSessionId } from "@/lib/session";

export const runtime = "nodejs";

export const MAX_BYTES = 50 * 1024 * 1024;

function bad(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Step 1 of upload: validate, then hand back a single-use signed URL scoped to one path.
 *
 * The bytes do not travel through this route — a serverless request body caps out around
 * 4.5 MB on Vercel, well under the 50 MB documents we need to accept. The service role
 * still decides what may be written and where; the browser never gets blanket write access.
 */
export async function POST(req: Request) {
  const sessionId = requestSessionId(req);
  if (!sessionId) return bad("Missing session. Reload the page and try again.", 400);

  let body: { filename?: unknown; size?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("Malformed request.", 400);
  }

  const { filename, size } = body;
  if (typeof filename !== "string" || !filename.trim() || filename.length > 255) {
    return bad("That filename isn't usable.", 400);
  }
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return bad("Only PDF files can be uploaded.", 415);
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return bad("That file looks empty.", 400);
  }
  if (size > MAX_BYTES) {
    return bad("That file is over the 50 MB limit.", 413);
  }

  const db = supabaseAdmin();

  const { data: existing, error: dupError } = await db
    .from("documents")
    .select("id")
    .eq("session_id", sessionId)
    .eq("filename", filename)
    .limit(1);

  if (dupError) {
    console.error("upload: duplicate check failed", dupError);
    return bad("Couldn't start the upload. Please try again.", 500);
  }
  if (existing?.length) {
    return bad(`You've already uploaded "${filename}". Rename it if you want a second copy.`, 409);
  }

  const docId = crypto.randomUUID();
  const path = `${sessionId}/${docId}.pdf`;

  const { data, error } = await db.storage.from("pdfs").createSignedUploadUrl(path);
  if (error || !data) {
    console.error("upload: signed url failed", error);
    return bad("Couldn't start the upload. Please try again.", 500);
  }

  return NextResponse.json({ docId, path: data.path, token: data.token });
}
