// Query key factory (apps/web R10). Permissions are keyed by user, so one account never reads another's.
export const authKeys = {
  all: ['auth'] as const,
  session: () => [...authKeys.all, 'session'] as const,
  allPermissions: () => [...authKeys.all, 'permissions'] as const,
  permissions: (userId: string) => [...authKeys.allPermissions(), userId] as const,
}
