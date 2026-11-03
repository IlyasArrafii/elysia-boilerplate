import { fileURLToPath } from 'node:url'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The only env file is the repo-root .env, two levels above this app.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig(({ mode }) => {
  // Prefix '' returns every key, not only VITE_*. Real environment variables win over the file.
  const env = loadEnv(mode, REPO_ROOT, '')
  const apiUrl = env.API_INTERNAL_URL || 'http://localhost:3000'

  return {
    server: {
      // Fixed port: a silent fallback to another port would break E2E URLs and the one-origin setup.
      port: 3001,
      strictPort: true,
      proxy: {
        // DEC-020: one origin. The pattern is anchored so `/apiary` is not proxied.
        // `xfwd` adds x-forwarded-* like the production reverse proxy does.
        '^/api(/|$)': { target: apiUrl, xfwd: true },
      },
    },
    plugins: [tanstackStart(), viteReact()],
  }
})
