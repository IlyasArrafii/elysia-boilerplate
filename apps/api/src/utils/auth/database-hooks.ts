import type { AuthDatabaseHooks } from '@repo/auth'
import { auditDatabaseHooks as audit } from './audit'
import { enforceBanAfterSession, enforceBanBeforeSession, isPluginBanLift } from './bans'
import { afterUserMutationCommit } from './user-mutation-lock'
import { notifyUserRemoved } from './user-removed'

export interface SessionAdapter {
  deleteSession(token: string): Promise<void>
}

// Better Auth `databaseHooks`: ban enforcement (bans.ts) first, then the audit events (audit.ts). An
// update or session the ban rules refuse is never audited as if it happened. A removed user is
// announced to the modules whose cache may hold their rows (user-removed.ts). `fallbackAdapter`
// serves the rare session created without an endpoint context.
export function createDatabaseHooks(fallbackAdapter: () => Promise<SessionAdapter>): AuthDatabaseHooks {
  return {
    ...audit,
    session: {
      ...audit.session,
      create: {
        async before(session) {
          await enforceBanBeforeSession(session.userId)
        },
        async after(session, ctx) {
          const adapter = ctx?.context.internalAdapter ?? (await fallbackAdapter())
          await enforceBanAfterSession(session, (token) => adapter.deleteSession(token))
          await audit.session?.create?.after?.(session, ctx)
        },
      },
    },
    user: {
      ...audit.user,
      update: {
        async before(data, ctx) {
          // `false` cancels the write; bans.ts lifts the ban itself when the session is created.
          if (isPluginBanLift(data, ctx)) return false
          return audit.user?.update?.before?.(data, ctx)
        },
        async after(user, ctx) {
          await audit.user?.update?.after?.(user, ctx)
        },
      },
      delete: {
        // remove-user runs in the user mutation lock's transaction, which is still open when Better
        // Auth calls "after": the listeners wait for the commit, or a reader could cache the rows again.
        async after(user) {
          await afterUserMutationCommit(() => notifyUserRemoved(user.id))
        },
      },
    },
  }
}
