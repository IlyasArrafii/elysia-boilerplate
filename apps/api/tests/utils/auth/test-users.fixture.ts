import { afterAll, beforeAll, expect, test } from 'bun:test'
import { prepareTestDatabase, storedUser, testUsers, type TestUser } from './setup'

// Run only by setup.test.ts in a child `bun test` (the name does not match *.test.ts, so the suite never
// picks it up). A test file that uses testUsers() the way the others do, with a user kept from
// beforeAll and a test that fails on purpose. It prints every id it creates, and the parent checks
// that none of them is left once this file has run.

const { createUser, cleanup } = testUsers()

afterAll(cleanup)

let kept: TestUser

beforeAll(async () => {
  if (!(await prepareTestDatabase())) throw new Error('The test PostgreSQL is not reachable')
  kept = await createUser('super_admin')
  console.log(`created-user ${kept.id}`)
})

test('creates a user', async () => {
  const created = await createUser()
  console.log(`created-user ${created.id}`)
  expect(await storedUser(created.id)).toBeDefined()
})

test('fails after creating a user', async () => {
  const created = await createUser('admin')
  console.log(`created-user ${created.id}`)
  throw new Error('fails on purpose')
})

test('the user from beforeAll is still there after the failing test', async () => {
  expect(await storedUser(kept.id)).toBeDefined()
  console.log('kept-user-present')
})
