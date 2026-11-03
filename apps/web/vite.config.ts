import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3000'

export default defineConfig({
  server: {
    // Fixed port: a silent fallback to another port would break E2E URLs and the one-origin setup.
    port: 3001,
    strictPort: true,
    proxy: {
      // DEC-020: one origin. The pattern is anchored so `/apiary` is not proxied.
      // `xfwd` adds x-forwarded-* like the production reverse proxy does.
      '^/api(/|$)': { target: API_URL, xfwd: true },
    },
  },
  plugins: [tanstackStart(), viteReact()],
})
