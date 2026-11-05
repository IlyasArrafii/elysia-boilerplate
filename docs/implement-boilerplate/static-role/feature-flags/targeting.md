# Feature Flag Targeting: Users Only, No Roles

> **Status: Design only (DEC-038).** Not built; see [README.md](README.md) for when flags are adopted. This document defines how a flag decides who gets the "on" value. It applies to the database provider and, as far as PostHog allows, to the PostHog provider.

## 1. Why no role targeting

Roles decide **access** (permissions). If flags could target roles, "who can see the new bulk delete" would be decided in two places, and a flag change could silently act like a permission change. So:

- The evaluation context contains only `targetingKey` (the user ID).
- A flag can never be turned on "for admins". If a behaviour belongs to admins, it is a **permission**. If it is a rollout that should start with some admins, list those admins' user IDs.

## 2. The four rules

Each flag has these targeting fields (database provider column names in brackets):

| Rule | Field | Meaning |
|:---|:---|:---|
| Kill switch | `enabled` | `false` = everyone gets the off value, whatever else is set |
| Exclude users | `excludeUserIds` | These users always get the off value |
| Include users | `includeUserIds` | These users always get the on value |
| Percentage rollout | `rolloutPercentage` (0–100, two decimals) | This share of all other signed-in users gets the on value |

## 3. Evaluation order

First match wins:

| # | Condition | Value | OpenFeature reason |
|:---|:---|:---|:---|
| 1 | Flag not in the catalogue or table | code default | `ERROR` (`FLAG_NOT_FOUND`) |
| 2 | Requested type ≠ flag type | code default | `ERROR` (`TYPE_MISMATCH`) |
| 3 | `enabled = false` | off value | `DISABLED` |
| 4 | `targetingKey` in `excludeUserIds` | off value | `TARGETING_MATCH` |
| 5 | `targetingKey` in `includeUserIds` | on value | `TARGETING_MATCH` |
| 6 | `rolloutPercentage = 100` | on value | `STATIC` |
| 7 | `targetingKey` present and `bucket(seed, targetingKey) < rolloutPercentage` | on value | `SPLIT` |
| 8 | otherwise | off value | `DEFAULT` |

Exclude beats include: a user on both lists is off. That makes "remove this one user from the rollout" always work.

## 4. Percentage bucketing

```ts
// sketch
function bucket(seed: string, targetingKey: string): number {   // 0.00 – 99.99
  const digest = createHash('sha256').update(`${seed}:${targetingKey}`).digest()
  return (digest.readUInt32BE(0) % 10_000) / 100
}
// seed = flag.bucketingSeed ?? flag.key
```

- **Sticky:** same user, same answer, on every request and instance.
- **Monotonic:** 10% → 30% keeps the first 10% and adds more. Going down removes users.
- **Independent per flag:** the key is in the hash, so the same users are not first in every rollout.
- **Reshuffle:** change `bucketingSeed` to pick a different group.
- SHA-256 from `node:crypto`, not `Bun.hash`, so buckets never change with a runtime upgrade.

## 5. Guests

Guests have no `targetingKey`. Rules 4, 5 and 7 cannot match, so guests get the on value only at 100% (rule 6), otherwise the off value. There is no shared guest ID: it would put every guest in the same bucket.

## 6. Recipes

| Goal | Settings |
|:---|:---|
| Internal testing first | `enabled: true`, `includeUserIds: [tester IDs]`, `rolloutPercentage: 0` |
| Canary | add `rolloutPercentage: 5`, then 25, 50, 100, watching errors per module in the log store |
| Pull one user out | add their ID to `excludeUserIds` |
| Emergency stop | `enabled: false` |
| Done | `rolloutPercentage: 100`, then delete the flag and its code branch before `removeBy` |
| "Only admins" | Not a flag. Add a permission ([auth/static-roles.md §9](../auth/static-roles.md#9-adding-a-custom-permission)) |

## 7. Limits

| Limit | Value | Why |
|:---|:---|:---|
| `includeUserIds` + `excludeUserIds` | ≤ 1 000 IDs per flag | The snapshot is in memory on every instance; larger groups use the percentage |
| Unknown user IDs in lists | Rejected by the admin API (checked against `user.id`) | Typos would silently do nothing |
| Deleted users | Left in lists; harmless; removed by the admin API's "clean lists" action | |

## 8. Tests

- Every row of §3, including exclude-beats-include and guests.
- Bucketing: fixed IDs give the same buckets on every run; 10 000 random IDs at 25% land within 24–26%; raising 10% → 30% keeps everyone who was on.
- The context builder outputs only `targetingKey` (a test asserts the object has exactly one key).
