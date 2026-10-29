import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dom-annotakit host app build (COPY-MAP build row): `base: './'` so a bake
// can sit at any subpath (the standalone server serves dist-app/ at the
// origin root; the bake's ref-shape gate is re-verified against THIS output).
// outDir dist-app — served by src/server/standalone.ts with SPA fallback.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-app',
    emptyOutDir: true,
  },
});
