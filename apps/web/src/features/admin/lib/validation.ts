import { sameRoles } from './users'

// Client checks for the admin forms. The API has no `model.ts` for these Better Auth endpoints; the limits below are
// the admin plugin's body schemas (1.7.15) and the API's guards (static-roles.md §7), so the client never allows
// what the API would refuse for a reason it can see in advance.

// `banExpiresIn` is a number of seconds; leaving it out bans until an admin unbans (the API sets no default).
export const BAN_DURATIONS = [
  { value: 'never', label: 'Until unbanned', seconds: undefined },
  { value: '1h', label: '1 hour', seconds: 60 * 60 },
  { value: '1d', label: '1 day', seconds: 24 * 60 * 60 },
  { value: '7d', label: '7 days', seconds: 7 * 24 * 60 * 60 },
  { value: '30d', label: '30 days', seconds: 30 * 24 * 60 * 60 },
] as const

export type BanDuration = (typeof BAN_DURATIONS)[number]['value']

export interface BanInput {
  reason: string
  duration: BanDuration
}

export interface BanBody {
  banReason?: string
  banExpiresIn?: number
}

export function isBanDuration(value: string): value is BanDuration {
  return BAN_DURATIONS.some((duration) => duration.value === value)
}

export function banDurationLabel(duration: BanDuration): string {
  return BAN_DURATIONS.find((entry) => entry.value === duration)?.label ?? duration
}

// An empty reason is left out, so the API stores its own default instead of an empty string.
export function toBanBody(input: BanInput): BanBody {
  const reason = input.reason.trim()
  const seconds = BAN_DURATIONS.find((entry) => entry.value === input.duration)?.seconds
  return {
    ...(reason === '' ? {} : { banReason: reason }),
    ...(seconds === undefined ? {} : { banExpiresIn: seconds }),
  }
}

export type RoleChangeProblem = 'own-account' | 'unchanged' | 'unknown-role' | null

// The UI assigns one role (static-roles.md §2). Own role changes are refused by the API (`CANNOT_CHANGE_OWN_ROLE`).
export function roleChangeProblem(input: {
  targetId: string
  currentUserId: string
  currentRoles: readonly string[]
  nextRole: string
  catalogue: readonly string[]
}): RoleChangeProblem {
  if (input.targetId === input.currentUserId) return 'own-account'
  if (!input.catalogue.includes(input.nextRole)) return 'unknown-role'
  if (sameRoles(input.currentRoles, [input.nextRole])) return 'unchanged'
  return null
}
