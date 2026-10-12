import Workspace from "./workspace";

export const dynamic = "force-dynamic";

const configured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

export default function Home() {
  if (!configured) {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
        <div className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Not configured yet</h2>
          <p className="mt-2 text-sm text-muted">
            Copy <code className="font-mono text-xs">.env.example</code> to{" "}
            <code className="font-mono text-xs">.env.local</code>, add your Supabase URL and keys,
            then run <code className="font-mono text-xs">supabase/schema.sql</code> in the SQL
            editor.
          </p>
        </div>
      </main>
    );
  }

  return <Workspace />;
}
