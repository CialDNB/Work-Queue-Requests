import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Root is web/ regardless of where vite is invoked from; output lands in web/dist,
// which the Worker serves via Static Assets (see wrangler.jsonc "assets").
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `npm run dev:web` proxies API traffic to `npm run dev` (wrangler on :8787).
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/_health': 'http://localhost:8787',
    },
  },
});
