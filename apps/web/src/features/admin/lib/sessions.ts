import { toIso } from './users'

// One of a user's sessions from `list-user-sessions` (Better Auth 1.7.15), without its token: what is shown and
// cached never holds one. `revoke-user-session` takes the token, so the revocation reads it uncached right before
// sending (`sessionToken`).
export interface AdminSession {
  id: string
  createdAt: string
  expiresAt: string
  ipAddress: string | null
  userAgent: string | null
}

export interface RawAdminSession {
  id: string
  token: string
  createdAt: Date | string
  expiresAt: Date | string
  ipAddress?: string | null
  userAgent?: string | null
}

export function toAdminSession(raw: RawAdminSession): AdminSession {
  return {
    id: raw.id,
    createdAt: toIso(raw.createdAt) ?? '',
    expiresAt: toIso(raw.expiresAt) ?? '',
    ipAddress: raw.ipAddress || null,
    userAgent: raw.userAgent || null,
  }
}

// Most recent first; Better Auth returns them in storage order.
export function toAdminSessions(raw: { sessions: RawAdminSession[] }): AdminSession[] {
  return raw.sessions.map(toAdminSession).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
