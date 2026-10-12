import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-line bg-surface p-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">404</p>
        <h1 className="mt-2 text-sm font-medium">There&apos;s nothing here</h1>
        <p className="mt-2 text-sm text-muted">
          That page doesn&apos;t exist. The documents you&apos;ve uploaded are still on the home
          page.
        </p>
        <Link
          href="/"
          className="mt-5 inline-block rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas"
        >
          Back to Docsense
        </Link>
      </div>
    </main>
  );
}
