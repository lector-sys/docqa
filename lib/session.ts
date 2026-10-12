/**
 * Anonymous session id. Generated in the browser on first visit, kept in a cookie, and sent
 * as `x-session-id` on every request. RLS uses it to scope a visitor to their own uploads.
 * It is a bearer capability, like a signed URL: unguessable, not an identity.
 */
export const SESSION_COOKIE = "docqa_sid";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Browser only. Reads the cookie, minting one on first visit. */
export function clientSessionId(): string {
  const existing = document.cookie.match(/(?:^|;\s*)docqa_sid=([^;]*)/)?.[1];
  if (isSessionId(existing)) return existing;
  const id = crypto.randomUUID();
  document.cookie = `${SESSION_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax`;
  return id;
}

/** Server only. Null if the header is missing or malformed. */
export function requestSessionId(req: Request): string | null {
  const value = req.headers.get("x-session-id");
  return isSessionId(value) ? value : null;
}
