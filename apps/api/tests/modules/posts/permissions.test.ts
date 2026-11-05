import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { app } from '../../../src/app'
import { env } from '../../../src/env'
import { postsPermissions } from '../../../src/modules/posts/permissions'
import { posts } from '../../../src/modules/posts'
import type { Permission } from '../../../src/utils/auth'
import { PERMISSIONS, permissionsOf, statement } from '../../../src/utils/auth/access'
import { ROLE_NAMES, type RoleName } from '../../../src/utils/auth/roles'
import { request } from '../../helpers/app'
import { createUser, type SignedInUser } from '../../helpers/auth'
import { fixtures, testDb } from '../../helpers/db'

// static-roles.md §5, the posts rows. Written by hand: a grant change must be made here too.
const POSTS_GRANTS: Record<RoleName, readonly Permission[]> = {
  super_admin: ['posts:manage_all', 'posts:read', 'posts:write'],
  admin: ['posts:manage_all', 'posts:read', 'posts:write'],
  user: ['posts:read', 'posts:write'],
}

const db = await testDb()
const scope = fixtures(db)
const POSTS_PERMISSIONS = postsPermissions.statement.posts.map((action) => `posts:${action}` as Permission)

describe('posts grants in the compiled roles (static-roles.md §5, §11)', () => {
  test('the posts statement is merged into the app statement', () => {
    expect(statement.posts).toEqual(['read', 'write', 'manage_all'])
    for (const permission of POSTS_PERMISSIONS) expect(PERMISSIONS).toContain(permission)
  })

  test.each([...ROLE_NAMES])('%s holds exactly its posts grants', (role) => {
    const held = permissionsOf(role).filter((permission) => permission.startsWith('posts:'))

    expect(held).toEqual([...POSTS_GRANTS[role]])
  })
})

// Every posts permission protects at least one route (static-roles.md §3). `manage_all` has no route
// of its own: it is the ownership rule's exception on PATCH and DELETE, proven below by status.
describe('every posts permission is used', () => {
  test('every posts route is mounted in the app', () => {
    const routes = app.routes.filter((route) => route.path.startsWith('/api/posts')).map((route) => `${route.method} ${route.path}`)

    expect(routes.sort()).toEqual(
      ['DELETE /api/posts/:id', 'GET /api/posts/', 'GET /api/posts/:id', 'PATCH /api/posts/:id', 'POST /api/posts/'].sort(),
    )
    expect(posts.routes).toHaveLength(5)
  })

  const callers = new Map<string, SignedInUser>()
  let owner: SignedInUser

  beforeAll(async () => {
    owner = await createUser(scope, db, 'user')
    for (const role of [...ROLE_NAMES, 'retired_role']) callers.set(role, await createUser(scope, db, role))
  })
  afterAll(() => scope.cleanup())

  function caller(role: string): SignedInUser {
    const found = callers.get(role)
    if (found === undefined) throw new Error(`no caller for ${role}`)
    return found
  }

  async function ownersPost(): Promise<string> {
    const response = await request('/api/posts', {
      method: 'POST',
      headers: { cookie: owner.cookie, origin: env.WEB_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `Matrix ${crypto.randomUUID()}`, content: 'Content long enough.' }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  // Each role × each route → status. `retired_role` stands for a role with no posts grant.
  async function statusesFor(role: string): Promise<Record<string, number>> {
    const { cookie } = caller(role)
    const json = { cookie, origin: env.WEB_URL, 'content-type': 'application/json' }
    const list = await request('/api/posts', { headers: { cookie } })
    const read = await request(`/api/posts/${await ownersPost()}`, { headers: { cookie } })
    const write = await request('/api/posts', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: `Matrix ${crypto.randomUUID()}`, content: 'Content long enough.' }),
    })
    const editOthers = await request(`/api/posts/${await ownersPost()}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ content: 'Edited by someone else.' }),
    })
    const deleteOthers = await request(`/api/posts/${await ownersPost()}`, { method: 'DELETE', headers: { cookie, origin: env.WEB_URL } })
    return {
      list: list.status,
      read: read.status,
      write: write.status,
      editOthers: editOthers.status,
      deleteOthers: deleteOthers.status,
    }
  }

  test.each([
    ['super_admin', { list: 200, read: 200, write: 201, editOthers: 200, deleteOthers: 204 }],
    ['admin', { list: 200, read: 200, write: 201, editOthers: 200, deleteOthers: 204 }],
    ['user', { list: 200, read: 200, write: 201, editOthers: 403, deleteOthers: 403 }],
    ['retired_role', { list: 403, read: 403, write: 403, editOthers: 403, deleteOthers: 403 }],
  ] as const)('%s: posts:read, posts:write and posts:manage_all decide these statuses', async (role, expected) => {
    expect(await statusesFor(role)).toEqual(expected)
  })
})
