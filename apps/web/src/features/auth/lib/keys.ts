// Query key factory (apps/web R10). Permissions are keyed by user, so one account never reads another's.
export const authKeys = {
  all: ['auth'] as const,
  session: () => [...authKeys.all, 'session'] as const,
  permissions: (userId: string) => [...authKeys.all, 'permissions', userId] as const,
}
