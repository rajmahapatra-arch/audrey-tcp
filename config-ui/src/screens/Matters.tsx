/**
 * Matters list — first authenticated screen.
 *
 * Purpose for Part 4: prove the end-to-end auth+RLS path works.
 * We query `matters` directly via the user-scoped Supabase client.
 * If the JWT carries the right user_id and the RLS policy from
 * migration 009 is in place, this returns only the signed-in user's
 * matters (or an empty list for a new sign-in).
 *
 * UI-wise this is intentionally bare for now — table of matters,
 * client name, last accessed, status. Matter-detail screen and
 * upload modal port (Part 5) will wire on top.
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { supabase } from '../lib/supabase';

interface MatterRow {
  id: string;
  matter_name: string | null;
  client_name: string | null;
  governing_law: string | null;
  archived: boolean;
  last_accessed: string | null;
  created_at: string;
}

async function fetchMatters(): Promise<MatterRow[]> {
  const { data, error } = await supabase
    .from('matters')
    .select('id, matter_name, client_name, governing_law, archived, last_accessed, created_at')
    .eq('archived', false)
    .order('last_accessed', { ascending: false, nullsFirst: false })
    .limit(100);

  if (error) {
    throw new Error(error.message);
  }
  return data ?? [];
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function Matters() {
  const { user, signOut } = useAuth();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['matters'],
    queryFn: fetchMatters,
  });

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-ink-900">Audrey</h1>
            <p className="text-xs text-ink-400">{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="text-sm text-ink-500 hover:text-ink-700 underline"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-ink-900">Matters</h2>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isLoading}
            className="text-sm text-ink-500 hover:text-ink-700 underline disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {isLoading && (
          <div className="text-sm text-ink-400">Loading matters…</div>
        )}

        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
            <div className="font-medium">Couldn't load matters</div>
            <div className="mt-1">{error instanceof Error ? error.message : String(error)}</div>
            <div className="mt-2 text-xs text-red-700">
              If you just signed in for the first time, your access may still be
              pending. If this looks like a config issue, check the browser console.
            </div>
          </div>
        )}

        {data && data.length === 0 && (
          <div className="rounded-md border border-dashed border-ink-200 px-6 py-12 text-center">
            <div className="text-ink-500 font-medium">No matters yet</div>
            <div className="mt-1 text-sm text-ink-400">
              Once Audrey ingests your first set of documents, matters will appear here.
            </div>
          </div>
        )}

        {data && data.length > 0 && (
          <div className="bg-white border border-ink-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-4 py-3">Matter</th>
                  <th className="text-left font-medium px-4 py-3">Client</th>
                  <th className="text-left font-medium px-4 py-3">Governing law</th>
                  <th className="text-left font-medium px-4 py-3">Last accessed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.map((m) => (
                  <tr key={m.id} className="hover:bg-ink-50">
                    <td className="px-4 py-3 text-ink-900">
                      {m.matter_name ?? <span className="italic text-ink-400">(unnamed)</span>}
                    </td>
                    <td className="px-4 py-3 text-ink-700">{m.client_name ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-500">{m.governing_law ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-500">{formatDate(m.last_accessed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-6 text-xs text-ink-400">
          Showing up to 100 active matters. Archived view, matter detail, and
          document upload land in the next iteration.
        </p>
      </main>
    </div>
  );
}
