import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { eq } from 'drizzle-orm'
import { createDb, type Database } from './client'
import { post, user } from './schema'

const SUPER_ADMIN_ROLE = 'super_admin'
const SUPER_ADMIN_NAME = 'Super Admin'

// Fixed slugs make the insert idempotent: a second run conflicts on `post.slug` and adds nothing.
const EXAMPLE_POSTS = [
  {
    slug: 'welcome-to-the-boilerplate',
    title: 'Welcome to the boilerplate',
    content: 'A published example post, so lists and detail pages have something to show.',
    status: 'published',
  },
  {
    slug: 'how-roles-and-permissions-work',
    title: 'How roles and permissions work',
    content: 'Roles live in code and grant permissions such as posts:read. Only the author may edit.',
    status: 'published',
  },
  {
    slug: 'unfinished-draft',
    title: 'An unfinished draft',
    content: 'A draft example post, visible to its author and to holders of posts:manage_all.',
    status: 'draft',
  },
] as const

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Add it to the repo-root .env (see .env.example).`)
  }
  return value
}

// Goes through Better Auth's API so the password is hashed exactly as in production. Mirror the hashing
// options of packages/auth here if they ever change (the defaults are used today). `autoSignIn: false`
// keeps the seed from leaving a session row behind.
function createSeedAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg' }),
    emailAndPassword: { enabled: true, autoSignIn: false },
    plugins: [admin({ defaultRole: 'user' })],
  })
}

async function ensureSuperAdmin(db: Database): Promise<string> {
  const email = requireEnv('SEED_SUPER_ADMIN_EMAIL').toLowerCase()
  const password = requireEnv('SEED_SUPER_ADMIN_PASSWORD')

  const existing = await db.query.user.findFirst({ where: eq(user.email, email) })
  if (existing?.role === SUPER_ADMIN_ROLE) {
    console.log(`super_admin ${email} already exists`)
    return existing.id
  }

  let userId = existing?.id
  if (userId === undefined) {
    const created = await createSeedAuth(db).api.signUpEmail({
      body: { name: SUPER_ADMIN_NAME, email, password },
    })
    userId = created.user.id
  }

  await db.update(user).set({ role: SUPER_ADMIN_ROLE }).where(eq(user.id, userId))
  console.log(`${existing ? 'promoted' : 'created'} super_admin ${email}`)
  return userId
}

async function ensureExamplePosts(db: Database, authorId: string): Promise<void> {
  const inserted = await db
    .insert(post)
    .values(EXAMPLE_POSTS.map((example) => ({ ...example, authorId })))
    .onConflictDoNothing({ target: post.slug })
    .returning({ slug: post.slug })

  console.log(`example posts: ${inserted.length} created, ${EXAMPLE_POSTS.length - inserted.length} already present`)
}

async function main(): Promise<void> {
  // First, before the environment or the database is touched: this script writes a known admin account.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:seed refuses to run when NODE_ENV=production.')
  }

  const db = createDb(requireEnv('DATABASE_URL'))
  try {
    const authorId = await ensureSuperAdmin(db)
    await ensureExamplePosts(db, authorId)
  } finally {
    await db.$client.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
