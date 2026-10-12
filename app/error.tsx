"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * The last stop before a stack trace would reach a visitor. The real error goes to the console
 * and the server logs; the page says what happened and what to do about it.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("unhandled error", error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-line bg-surface p-6">
        <h1 className="text-sm font-medium">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">
          This page hit an error it didn&apos;t expect. Your documents are unaffected — nothing was
          lost.
        </p>
        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-line px-3.5 py-2 text-sm hover:border-accent hover:text-accent"
          >
            Start over
          </Link>
        </div>
        {error.digest && (
          <p className="mt-4 font-mono text-[11px] text-muted">Reference: {error.digest}</p>
        )}
      </div>
    </main>
  );
}
