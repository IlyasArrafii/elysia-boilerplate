# PostHog Feature Flag Provider (optional)

> **Status: Design only (DEC-029, DEC-038).** Not built; see [README.md](README.md) for when flags are adopted. Use instead of the [database provider](database-provider.md) only when the team needs multivariate experiments or flag analytics. PostHog's Node provider was at 0.1.x in 2026-11; *verify* its maturity and API at adoption. PostHog analytics (events) is a separate plan: [observability/posthog.md](../observability/posthog.md).

## 1. Packages

| Package | Where | Role |
|:---|:---|:---|
| `@openfeature/server-sdk` | `apps/api` | OpenFeature API (unchanged) |
| `posthog-node` | `apps/api` | PostHog client (shared with the analytics sink if both are used) |
| `@posthog/openfeature-node-provider` | `apps/api` | Official provider: `new PostHogServerProvider(posthog, options)` |

The web app installs nothing and keeps reading `GET /api/feature-flags/evaluate`.

## 2. Setup

| Env | Required | Notes |
|:---|:---|:---|
| `POSTHOG_KEY` | yes | Project API key |
| `POSTHOG_HOST` | no | US, EU or self-hosted |
| `POSTHOG_PERSONAL_API_KEY` | yes | **Secret.** Enables local evaluation (flag definitions downloaded, evaluated in memory). *Verify* whether PostHog now recommends a dedicated feature-flags key. |

```ts
// utils/feature-flag/index.ts (sketch)
const posthog = new PostHog(env.POSTHOG_KEY, {
  host: env.POSTHOG_HOST,
  personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
  featureFlagsPollingInterval: 30_000,            // *verify* option name
})
await OpenFeature.setProviderAndWait(new PostHogServerProvider(posthog, { sendFeatureFlagEvents: false }))
// shutdown: await OpenFeature.close(); await posthog.shutdown()
```

- **Local evaluation is required**: without it every flag check is a network call on the request path.
- `sendFeatureFlagEvents: false` by default; turn on only for experiment flags that need exposure events.

## 3. Targeting in PostHog, without roles

| Our rule ([targeting.md](targeting.md)) | PostHog |
|:---|:---|
| Kill switch | Flag disabled |
| Exclude users | First release condition: distinct ID in list → rollout 0% |
| Include users | Next condition: distinct ID in list → rollout 100% |
| Percentage | Last condition: all users → X% (hashed on distinct ID + flag key, sticky) |
| Experiment (PostHog only) | Multivariate flag with weights; read with `getStringValue` |

**No person properties.** The context sends only `targetingKey` → `distinctId`. Do not create release conditions on `role` or any other property; a review rejects them (DEC-038). Guests get code defaults (no `defaultDistinctId`).

## 4. Behaviour and caveats

| Case | Result |
|:---|:---|
| Flag not in PostHog | Default, `FLAG_NOT_FOUND` |
| Wrong typed getter | Default, `TYPE_MISMATCH` |
| PostHog unreachable | Last downloaded definitions keep working |
| Disabled vs no matching condition | Indistinguishable in the Node provider (no `DISABLED` reason) |

The code catalogue (`flags.ts`) stays the list of flags the code uses. An optional CI script compares it to PostHog's flag list and warns about flags on one side only. Flags are managed in the PostHog UI, which keeps its own history, so `audit.feature_flag.changed` is not emitted.

## 5. Migration: database provider → PostHog

1. Decision entry (product owner accepts pricing and data region).
2. Install the packages; add env variables to `env.ts` and `.env.example`.
3. Recreate each flag in PostHog with the same key and type: kill switch → enabled state; exclude list, include list and percentage → release conditions in the order of §3.
4. Pick the moment: buckets **differ** (different hash), so some users switch sides. Migrate when no rollout is between 1% and 99%, or accept the reshuffle.
5. Switch `setProviderAndWait(...)` to the PostHog provider behind a deploy; staging first.
6. Watch `flag.evaluation_failed` and errors per module for a day.
7. Later migration: drop the `feature_flag` table and the `feature-flags` admin endpoints; keep `/api/feature-flags/evaluate`.
8. Update these documents to describe what was built (DEC-053).

Rollback before step 7: switch the provider back; the table is still there.

## 6. Checklist

- [ ] Pricing accepted at expected traffic (*verify* how local evaluation is billed); data region chosen.
- [ ] Only `distinctId` is sent; asserted by a test with a mocked client.
- [ ] No release condition uses a person property.
- [ ] `POSTHOG_PERSONAL_API_KEY` stored as a secret and never logged.
- [ ] `posthog.shutdown()` and `OpenFeature.close()` in graceful shutdown.
