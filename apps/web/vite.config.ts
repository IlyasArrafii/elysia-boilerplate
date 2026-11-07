import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { DEV_API_INTERNAL_URL } from './src/lib/dev-api-url.ts'

// The repo-root .env is loaded by the `dev` script (`bun --env-file`), which puts it in `process.env` for this
// process and the SSR running inside it. Real environment variables win over the file.
const apiUrl = process.env.API_INTERNAL_URL || DEV_API_INTERNAL_URL

export default defineConfig(({ command }) => {
  // `vite build` keeps a NODE_ENV that is already set, so a shell or build machine with NODE_ENV=development or test
  // would ship React's development build and an apiOrigin() that falls back to the dev URL instead of throwing.
  // Vite reads NODE_ENV after loading this file, so setting it here wins. A `NODE_ENV=production vite build` script
  // prefix does not: under `bun run` (Bun 1.4.4, Windows) the outer value still reaches Vite.
  if (command === 'build') process.env.NODE_ENV = 'production'
  return {
    // No env files of Vite's own: the root .env is the only one, and it is already in `process.env`.
    envDir: false,
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
