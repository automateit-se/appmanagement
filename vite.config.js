import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// version shown in the footer: APP_VERSION from the build (the git tag in CI, e.g. 0.1.1), else package.json
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const version = (process.env.APP_VERSION || '').trim().replace(/^v/, '') || pkg.version;

// In development everything that is not the app itself goes to the backend (npm run dev:server, port 8080),
// exactly like in the container where the backend serves the app too.
const backend = (process.env.BACKEND_URL || 'http://localhost:8080').replace(/\/$/, '');
console.log(`\n  /api, /app-api, /config.json -> ${backend}\n`);

export default defineConfig({
  // relative asset URLs: the same build works at / and under any path prefix (e.g. /appmanagement/)
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/': { target: backend, changeOrigin: true },
      '/app-api/': { target: backend, changeOrigin: true },
      '/config.json': { target: backend, changeOrigin: true },
    },
  },
});
