import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  // Only `drizzle-kit migrate` connects. `generate` works offline, so a missing URL must not fail here.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
