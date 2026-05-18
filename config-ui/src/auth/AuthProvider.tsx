/**
 * AuthProvider — keeps the current Supabase session in React state so
 * the rest of the tree can read it via `useAuth()`.
 *
 * On mount: bootstraps the session from local storage (Supabase handles
 * the persistence), then subscribes to onAuthStateChange so sign-in /
 * sign-out / token-refresh events propagate to consumers.
 *
 * Sign-in uses Supabase's signInWithOAuth(microsoft). The OAuth dance
 * lands on /auth/callback, which is just a "loading" page — Supabase's
 * detectSessionInUrl flag picks up the token from the URL hash and
 * fires onAuthStateChange, so we don't need to parse the URL ourselves.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithMicrosoft: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    // 1. Bootstrap: read whatever session Supabase already has cached.
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });

    // 2. Subscribe for the lifetime of the provider. The Supabase SDK
    //    deduplicates events, so wired here once for the whole app.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signInWithMicrosoft: async () => {
        const redirectTo =
          (import.meta.env.VITE_APP_URL ?? window.location.origin) + '/auth/callback';
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'azure',
          options: {
            redirectTo,
            // 'email openid profile' is the safe minimum — additional
            // Graph scopes (e.g. Mail.Read for inbox ingestion later)
            // would be added per feature, not blanket here.
            scopes: 'email openid profile',
          },
        });
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[auth] Microsoft sign-in failed:', error.message);
          throw error;
        }
      },
      signOut: async () => {
        const { error } = await supabase.auth.signOut();
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[auth] Sign-out failed:', error.message);
        }
      },
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
