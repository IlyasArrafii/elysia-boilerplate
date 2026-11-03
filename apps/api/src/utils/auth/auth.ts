import { createDb } from '@repo/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'

// Minimal config for the Better Auth CLI (`bun run auth:generate`): the options that shape the database
// schema. The CLI only reads them and never queries, and the connection is lazy, so this URL is never
// dialled. The full server (secret, cookies, Redis, roles, hooks) replaces this file in TASK-04, which
// must regenerate the schema if it adds anything that changes a table.
export const auth = betterAuth({
  database: drizzleAdapter(createDb('postgres://schema-generation-only'), { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  plugins: [admin({ defaultRole: 'user' })],
})
