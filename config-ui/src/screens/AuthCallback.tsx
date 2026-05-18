/**
 * /auth/callback — landing page after the Microsoft OAuth round-trip.
 *
 * Supabase's detectSessionInUrl=true setting (in lib/supabase.ts) means
 * the SDK parses the URL hash automatically and fires
 * onAuthStateChange. So this page mostly just shows a loading state
 * until `session` arrives, then redirects to the matters list.
 *
 * If the OAuth flow returned an error in the URL params (user
 * declined consent, IdP misconfigured, etc.) we surface it here rather
 * than silently dropping back to sign-in.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export function AuthCallback() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Supabase sometimes puts errors in the query string, sometimes in
  // the URL fragment. Check both lightly.
  useEffect(() => {
    const err = params.get('error_description') ?? params.get('error');
    if (err) {
      setOauthError(err);
      return;
    }
    const hash = window.location.hash.slice(1);
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      const hashErr = hashParams.get('error_description') ?? hashParams.get('error');
      if (hashErr) setOauthError(hashErr);
    }
  }, [params]);

  // Once a session is in hand, head to the app.
  useEffect(() => {
    if (!loading && session) {
      navigate('/', { replace: true });
    }
  }, [loading, session, navigate]);

  if (oauthError) {
    return (
      <div className="min-h-screen bg-ink-50 flex items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <h2 className="text-lg font-medium text-ink-900">Sign-in didn't complete</h2>
          <p className="mt-2 text-sm text-ink-500">{oauthError}</p>
          <button
            type="button"
            onClick={() => navigate('/sign-in', { replace: true })}
            className="mt-4 text-sm text-accent-600 hover:text-accent-700 underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-50 flex items-center justify-center text-ink-400 text-sm">
      Signing you in…
    </div>
  );
}
