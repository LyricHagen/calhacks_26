import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: the key stays on the dev server and never reaches the bundle.
  const env = loadEnv(mode, '.', '');
  const ttsModel = env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const chatModel = env.GEMINI_CHAT_MODEL || 'gemini-3.1-flash-lite';

  const gemini = (model: string): ProxyOptions => ({
    target: 'https://generativelanguage.googleapis.com',
    changeOrigin: true,
    rewrite: () => `/v1beta/models/${model}:generateContent`,
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
  });

  const proxy: Record<string, ProxyOptions> = {
    '/api/tts': gemini(ttsModel),
    '/api/ask': gemini(chatModel),
  };

  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { proxy },
    build: { outDir: 'dist' },
  };
});
