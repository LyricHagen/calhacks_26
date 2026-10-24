import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: the key stays on the dev server and never reaches the bundle.
  const env = loadEnv(mode, '.', '');
  const model = env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

  const proxy: Record<string, ProxyOptions> = {
    '/api/tts': {
      target: 'https://generativelanguage.googleapis.com',
      changeOrigin: true,
      rewrite: () => `/v1beta/models/${model}:generateContent`,
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
    },
  };

  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { proxy },
    build: { outDir: 'dist' },
  };
});
