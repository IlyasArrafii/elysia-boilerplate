# PostHog: Product Analytics (design only)

> **Status: design only (DEC-036).** The baseline is the manual log (stdout + MongoDB). This document is the build and migration plan for adding PostHog product analytics. PostHog as a **feature flag provider** is a separate plan: [feature-flags/posthog-provider.md](../feature-flags/posthog-provider.md). Package names and options were checked in 2026-11; *verify* at build time.

## 1. What PostHog adds, and what it doesn't

| PostHog gives | Still from the manual log |
|:---|:---|
| Funnels, retention, trends ("how many users created a post") | Request lines, errors, audit trail |
| Per-user event history for product questions | Security investigations |
| Optional error tracking if Sentry is not used | Retention of technical logs |

Adopt when the product owner has product questions the log cannot answer cheaply. No `product.*` event exists yet (§3 lists the ones to add); the `product` kind already has a 30-day retention ([log-storage.md §5.1](log-storage.md)).

### 1.1 PostHog is not the log or trace store

PostHog also offers Logs and distributed tracing, both ingested over OpenTelemetry (OTLP/HTTP, billed per GB; checked 2026-11). This design does **not** use them:

- **Logs** stay in stdout + MongoDB, and later Loki or ELK ([migration-loki.md](migration-loki.md), [migration-elk.md](migration-elk.md)). Sending them to PostHog would need an OTLP exporter (OpenTelemetry was dropped, DEC-013) and would put technical logs in a product-analytics tool.
- **Traces** do not exist in this design ([README.md §9](README.md)); `requestId` is the correlation.
- Using PostHog as the log store would be its own migration spec and decision, like the Loki and ELK ones, not an extension of this document.

### 1.2 Analytics and feature flags are two separate integrations

| | Analytics (this document) | Feature flags ([posthog-provider.md](../feature-flags/posthog-provider.md)) |
|:---|:---|:---|
| Direction | API → PostHog: sends events | PostHog → API: downloads flag definitions, evaluates in memory |
| Called through | `telemetry.emit('product.*', …)` → `sinks/posthog.ts` | OpenFeature `client.getBooleanValue(…)` → `utils/feature-flag/` |
| Packages | `posthog-node` | `posthog-node`, `@openfeature/server-sdk`, `@posthog/openfeature-node-provider` |
| Keys | `POSTHOG_KEY` | `POSTHOG_KEY` + `POSTHOG_PERSONAL_API_KEY` (secret, for local evaluation) |
| On the request path | Never awaited | In-memory evaluation, no network call |
| Decision | Adopts analytics only | Adopts the provider only (the database provider stays the default, DEC-029) |

Adopting one never adopts the other. When both are adopted they share a single `posthog-node` client (created once, shut down once); nothing else is shared.

## 2. Package and configuration

`posthog-node` in `apps/api` only. The web app installs nothing (frontend telemetry is out of scope, DEC-015).

| Env | Required | Notes |
|:---|:---|:---|
| `POSTHOG_KEY` | to enable | Project API key (write-only) |
| `POSTHOG_HOST` | no | `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or self-hosted |

```ts
// apps/api/src/utils/telemetry/sinks/posthog.ts (sketch)
const client = new PostHog(env.POSTHOG_KEY, {
  host: env.POSTHOG_HOST,
  flushAt: 20,             // batch size
  flushInterval: 10_000,   // ms
  disableGeoip: true,      // *verify* option name; no IP-based location
})
```

If PostHog is also the feature-flag provider, both reuse this one client.

## 3. What it captures

| Event | Sent? | How |
|:---|:---|:---|
| `product.*` with a `userId` | yes | `client.capture({ distinctId: userId, event: '<name without product.>', properties })` |
| `product.*` without a `userId` (guests) | no | No anonymous server-side tracking |
| `http.*`, `audit.*`, `app.*` | no | They stay in the log |
| `http.error` ≥ 500 | only if Sentry is not used | Rebuild an `Error` from the line's `err`, a `SerializedError` ([sentry.md §4](sentry.md)), then `client.captureException(error, userId, { module, code, requestId })` (*verify* API) |

**Property allowlist.** Each `product.*` event lists its allowed properties in `events.ts` (e.g. `post_created: ['postId', 'status']`). The sink drops every other property. PostHog never receives free text, email, name or IP. `module` is always added as a property.

### Product events to add at adoption

| Event | Properties | Emitted from |
|:---|:---|:---|
| `product.user_signed_up` | `method` (`email` / `google`) | Better Auth `user.create.after` |
| `product.post_created` | `postId`, `status` | `PostService.create` |
| `product.post_published` | `postId` | `PostService.update` on status change |

## 4. Implementation steps

1. Decision entry adopting PostHog analytics (refines DEC-036); product owner accepts pricing and the data region (US/EU).
2. `bun add posthog-node` in `apps/api`.
3. Write `sinks/posthog.ts`, registered with a dynamic `import()` only when `POSTHOG_KEY` is set.
4. Add the `product.*` events (§3) with allowlists; add `'posthog'` to `SinkName` (`types.ts`) and to their `sinks`.
5. Add `POSTHOG_*` to `env.ts` and `.env.example`.
6. Tests in `apps/api/tests/utils/telemetry/posthog.test.ts` with a mocked client (§6).
7. Staging project first; check events and properties in PostHog; then production.
8. Once PostHog holds product history, `product.*` may be removed from the `mongo` sink (decision).
9. Update the docs in this folder in the same change (DEC-053): this file's status, DECISIONS, the ARCHITECTURE environment table and the event catalogue in [README.md §6](README.md). Never edit `docs/specs/` (DEC-052).

## 5. Removing it

Unset `POSTHOG_KEY`, then remove the sink, the `'posthog'` entries and the package. Product events keep going to the log.

## 6. Acceptance criteria

- [ ] Without `POSTHOG_KEY`, `posthog-node` is never loaded.
- [ ] Only `product.*` events with a `userId` reach PostHog, with allowlisted properties plus `module`.
- [ ] No email, name, IP or content in any captured payload (mocked client).
- [ ] SIGTERM calls `client.shutdown()` and pending events are delivered (*verify* whether it takes a timeout).
