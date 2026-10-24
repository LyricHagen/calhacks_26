// Offline replay of a saved session, no browser needed:
//   npm run replay -- path/to/chokesense-session.json [--quiet] [--grep text]
//   npm run replay                     (the demo recording)
// Bundles scripts/replay-entry.ts with esbuild (ships with Vite) and runs it.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./replay-entry.ts', import.meta.url));
const res = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'warning' });
await import(`data:text/javascript;base64,${Buffer.from(res.outputFiles[0].text).toString('base64')}`);
