// Removing a user cascades in PostgreSQL to the rows that reference them (a module's `author_id`,
// for instance), past the module's service, so its cache would keep serving them. A module whose
// cached data can hold a user's rows registers here; utils/auth never imports a module.
type UserRemovedListener = (userId: string) => Promise<void>

const listeners: UserRemovedListener[] = []

// Called once, when the module loads, next to the cache it clears.
export function onUserRemoved(listener: UserRemovedListener): void {
  listeners.push(listener)
}

// Runs from the `user.delete.after` hook once the removal has committed (database-hooks.ts). Every
// listener runs; the first rejected listener is rethrown.
export async function notifyUserRemoved(userId: string): Promise<void> {
  const results = await Promise.allSettled(listeners.map((listener) => listener(userId)))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed !== undefined) throw failed.reason
}
