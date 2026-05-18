/**
 * Route guard — wraps any route that requires a signed-in user.
 *
 * While the AuthProvider is bootstrapping (loading=true), renders a
 * minimal loading state to avoid flashing the sign-in screen before
 * we know whether a cached session exists.
 *
 * Unauthenticated users get redirected to /sign-in with the original
 * destination captured in location state, so post-auth we can land
 * them where they were trying to go.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-400 text-sm">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
