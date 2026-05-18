import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the Audrey TCP configuration UI.
//
// Dev server runs on 3002 to leave 3000 free for the local plugin host and
// 3001 free for the legacy backend during the parity transition.
// Production deploy targets app.audrey.xeqtor.com — see infra/ when the
// Railway/Vercel split is decided.

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3002,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
