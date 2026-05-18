/**
 * Sign-in screen. One button — "Continue with Microsoft" — which kicks
 * off the OAuth dance through Supabase's signInWithOAuth(azure).
 *
 * If the user lands here while already signed in (e.g. they bookmarked
 * /sign-in), we redirect them to the originally-requested page or /.
 */

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

interface LocationState {
  from?: string;
}

export function SignIn() {
  const { session, signInWithMicrosoft } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already signed in, bounce to wherever they were headed.
  useEffect(() => {
    if (session) {
      const dest = (location.state as LocationState | null)?.from ?? '/';
      navigate(dest, { replace: true });
    }
  }, [session, navigate, location.state]);

  const handleClick = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithMicrosoft();
      // signInWithOAuth redirects the whole page to Microsoft, so
      // we won't actually reach a "success" point here under normal
      // flow.
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    }
  };

  return (
    <div className="min-h-screen bg-ink-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white border border-ink-200 rounded-xl shadow-sm p-8">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-ink-900">Audrey</h1>
            <p className="mt-1 text-sm text-ink-500">
              Matter context for legal work.
            </p>
          </div>

          {error && (
            <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleClick}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 rounded-md
                       bg-ink-900 px-4 py-2.5 text-sm font-medium text-white
                       hover:bg-ink-800 focus:outline-none focus:ring-2 focus:ring-accent-500
                       focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {busy ? (
              <span>Redirecting…</span>
            ) : (
              <>
                {/* Inline SVG Microsoft logo — four-square mark, public. */}
                <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
                  <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                  <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                  <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                  <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                <span>Continue with Microsoft</span>
              </>
            )}
          </button>

          <p className="mt-6 text-xs text-ink-400 leading-relaxed">
            Access is currently invite-only. If you reach a waitlist screen
            after signing in, your email is on the queue — Raj will reach
            out when access is granted.
          </p>
        </div>
      </div>
    </div>
  );
}
