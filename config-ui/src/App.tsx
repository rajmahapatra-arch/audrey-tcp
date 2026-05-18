/**
 * Top-level app shell.
 *
 * Wires:
 *   QueryClientProvider → AuthProvider → BrowserRouter → routes
 *
 * Routes are intentionally tiny right now — sign-in / callback / one
 * protected matters list. Matter-detail, document upload, and position
 * curation come next.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { queryClient } from './lib/queryClient';
import { AuthCallback } from './screens/AuthCallback';
import { Matters } from './screens/Matters';
import { SignIn } from './screens/SignIn';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Matters />
                </RequireAuth>
              }
            />
            {/* Catch-all: send anything we haven't built yet back to /. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
