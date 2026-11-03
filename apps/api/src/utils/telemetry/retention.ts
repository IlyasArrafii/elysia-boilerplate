import type { Kind } from './types'

// How long each kind is kept in the log store (log-storage.md §5.1). The API never deletes logs;
// `bun run logs:prune` reads this table.
export const retentionDays = {
  http: 14,
  app: 30,
  error: 30,
  product: 30,
  audit: 365,
} as const satisfies Record<Kind, number>
