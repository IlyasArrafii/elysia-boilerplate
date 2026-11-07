# Feature Flags

> **Status: Design only (DEC-012, DEC-029, DEC-038).** Nothing in `feature-flags/` is built: no OpenFeature package is installed and no flag code exists. Build it only when the trigger in [README.md](../README.md#optional--later-design-only) fires and a new DEC entry adopts it. When flags are adopted, the **database provider is the default** and targeting is by **user only, never by role**. Package names and APIs were checked in 2026-11; *verify* versions at adoption.

| Document | Covers |
|:---|:---|
| This file | Why OpenFeature, when to use a flag, code placement, evaluation context, conventions, adoption |
| [targeting.md](targeting.md) | Targeting rules without roles: kill switch, exclude/include users, percentage rollout |
| [database-provider.md](database-provider.md) | Default provider: our own, over a PostgreSQL table managed through Drizzle |
| [posthog-provider.md](posthog-provider.md) | Optional provider for experiments and flag analytics, and how to migrate to it |

## 1. Why OpenFeature

OpenFeature is a vendor-neutral feature flag API (CNCF). App code calls only the OpenFeature API; a **provider** decides where flags come from. Changing provider is one line at startup.

```
controller ──► OpenFeature client ──► provider ──► feature_flag table (default)   database-provider.md
                                              └──► PostHog                         posthog-provider.md
                                              └──► in-memory                       tests
```

## 2. When to use a flag, and when not to

| Use a flag for | Do not use a flag for |
|:---|:---|
| Gradual rollout of new behaviour (5% → 25% → 100%) | **Access control.** Who may do what is a permission ([auth/static-roles.md](../auth/static-roles.md)) |
| A kill switch for a risky feature | Permanent configuration (env variable) |
| Early access for named users (internal testers) | Hiding an endpoint that is not safe yet |
| A short experiment (PostHog provider only) | Targeting a role ("all admins"): use a permission, or an explicit user list |

Hard rule: a flag only **narrows** behaviour. It never widens access. A route behind a flag still needs its `permission`.

## 3. Code placement: API

```
apps/api/src/utils/feature-flag/
  index.ts      named plugin 'feature-flag': sets the provider once, decorates `flags`
  flags.ts      typed flag catalogue: key, type, safe default, clientVisible, owner, removeBy
  context.ts    builds the evaluation context from the session (§5)
  hook.ts       OpenFeature hook that emits telemetry events (§7)
  providers/
    database.ts (database-provider.md)
apps/api/src/modules/feature-flags/   admin API for the database provider
```

```ts
// modules/posts/index.ts (sketch)
.delete('/bulk', async ({ flags, user, body }) => {
  const enabled = await flags.getBooleanValue('posts.bulk-delete', false, toContext(user))
  if (!enabled) throw moduleError('posts', 404, 'NOT_FOUND', 'Not found')
  return PostService.bulkDelete(user.id, body.ids)
}, { permission: 'posts:manage_all' })
```

- Services never read flags. The controller evaluates the flag and passes the result as a plain argument.
- Evaluating a key not in `flags.ts` is a TypeScript error.
- Graceful shutdown calls `await OpenFeature.close()`.

## 4. Code placement: web

The web app does **not** evaluate flags and installs no OpenFeature SDK:

- `GET /api/feature-flags/evaluate` (`auth: true`) returns `{ flags: { "posts.bulk-delete": true, … } }` for the current user, only flags marked `clientVisible`.
- A hook in `features/<feature>/hooks/` reads it through TanStack Query (`useFlag('posts.bulk-delete')`).
- Flags in the web app are for UI only; anything that affects data is checked on the API too.

One evaluation point: the API and UI never disagree, rules and percentages are never sent to the browser, and swapping provider does not touch the web app.

## 5. Evaluation context

| Field | Source | Notes |
|:---|:---|:---|
| `targetingKey` | `user.id` | Missing for guests |

**Nothing else.** No role, email, name, IP, plan or other attribute goes to any provider (DEC-038, [redaction.md §6](../observability/redaction.md)). Environments are separate databases, so there is no `env` attribute either.

## 6. Provider path

| Step | Provider | When |
|:---|:---|:---|
| Tests | `InMemoryProvider` with explicit values | Always |
| 1 (default) | **Database provider** | First adoption: flags changed without a deploy, kill switch, user lists, percentage rollout |
| 2 (optional) | **PostHog provider** | Multivariate experiments or flag analytics are needed; vendor cost is the product owner's call |

## 7. Observability

One global OpenFeature hook in `utils/feature-flag/hook.ts` emits telemetry events (module `"feature-flags"` for the admin API, the calling module otherwise):

| Event | Kind | Payload | Level |
|:---|:---|:---|:---|
| `flag.evaluation_failed` | `app` | `key, errorCode, defaultUsed` | warn |
| `flag.evaluated` | `app` | `key, variant, reason` | debug only (stdout, not MongoDB) |
| `flag.refresh_failed` | `app` | `provider, errorCode` | warn |
| `flag.orphaned` | `app` | `key` | warn |
| `audit.feature_flag.changed` | `audit` | `key, actorId, changes` (field names and old/new values; user ID lists as counts added/removed, never the IDs) | info |

Added to `utils/telemetry/events.ts` at adoption.

## 8. Conventions

- **Key:** `<module>.<kebab-name>`, e.g. `posts.bulk-delete`.
- **Default** is always the safest value (usually `false` or the old behaviour), in code and in the provider.
- Every flag has an `owner` and, if temporary, a `removeBy` date. Past `removeBy`, the flag and its branch are deleted; CI warns on expired flags.
- Never more than one flag guarding the same code path.
- Tests use `InMemoryProvider`; folder `apps/api/tests/utils/feature-flag/` ([TESTING.md](../TESTING.md)).

## 9. Adoption checklist

1. Decision entry: "feature flags implemented with the database provider" (updates DEC-012).
2. `bun add @openfeature/server-sdk` in `apps/api`; create `utils/feature-flag/` per §3.
3. Drizzle schema and migration for `feature_flag` ([database-provider.md §2](database-provider.md)).
4. Implement the provider and the `feature-flags` module.
5. Add `OpenFeature.close()` to graceful shutdown as a step in the clients group of `shutdownPlan` (`utils/lifecycle/index.ts`), whose steps run together, so the plan stays inside its 9.5 s deadline; add the hook and events (§7).
6. Add `GET /api/feature-flags/evaluate` and the web hook (§4).
7. One example flag in `posts` with tests for on, off, include, exclude, rollout and provider failure.
8. Update these documents to describe what was built, and mark them built instead of design only (DEC-053).
