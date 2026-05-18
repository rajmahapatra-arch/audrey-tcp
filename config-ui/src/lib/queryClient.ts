/**
 * React Query client singleton.
 *
 * Defaults tuned for an internal-tool feel — staleness short enough
 * that the matters list reflects ingestion-job completion within a
 * sensible polling window, but not aggressive enough to burn quota on
 * tabs left open all day.
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 30s staleness is enough that flipping between tabs doesn't
      // re-fetch every list, but new uploads land within a refresh.
      staleTime: 30_000,
      // Retry once on failure — most likely a transient supabase blip,
      // not a logic error. Mutation retries handled per-call.
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
