import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The only env file is the repo-root .env, two levels above this app.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// Vite re-evaluates this file on a server restart inside the same process. By then `process.env` holds the
// value copied in below, and `loadEnv` would mistake it for a real variable and ignore an edited .env. So the
// real value is recorded once per process (globalThis outlives the re-evaluation) and put back before loading.
const SHELL_API_URL = Symbol.for('@repo/web:shell-API_INTERNAL_URL')
type ShellRecord = { [SHELL_API_URL]?: { value: string | undefined } }

function restoreShellApiUrl() {
  const record = globalThis as ShellRecord
  record[SHELL_API_URL] ??= { value: process.env.API_INTERNAL_URL }
  const { value } = record[SHELL_API_URL]
  if (value === undefined) delete process.env.API_INTERNAL_URL
  else process.env.API_INTERNAL_URL = value
}

export default defineConfig(({ command, mode }) => {
  restoreShellApiUrl()
  // Prefix '' returns every key, not only VITE_*. Real environment variables win over the file.
  const env = loadEnv(mode, REPO_ROOT, '')
  const apiUrl = env.API_INTERNAL_URL || 'http://localhost:3000'

  if (command === 'serve') {
    // In dev, SSR runs inside this process and reads `process.env.API_INTERNAL_URL` (src/lib/api-origin.ts),
    // but `loadEnv` never writes to `process.env`. Hand it the same URL the proxy uses. Not done for builds:
    // the built server reads the real environment at runtime, and nothing is baked into the bundle.
    process.env.API_INTERNAL_URL = apiUrl
  }

  return {
    resolve: {
      // `@/` → `src/`, from the `paths` in tsconfig.json (one source of truth for tsc and Vite).
      tsconfigPaths: true,
    },
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
    plugins: [tailwindcss(), tanstackStart(), viteReact()],
  }
})
