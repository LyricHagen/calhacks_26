import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A static single-page app served from the site root. Every route is index.html
// (vercel.json rewrites them); public/ is copied to dist/ as is, so
// public/torso.glb is served at /torso.glb. shared/ is bundled through imports.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    // three.js is its own lazy chunk (Torso3D), loaded only when WebGL works.
    chunkSizeWarningLimit: 1100,
  },
});
