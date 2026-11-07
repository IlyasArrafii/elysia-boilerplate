# Migration: Redis → Valkey

> Redis 8.10 is the default server for the `redis` service in every Compose stack and in CI ([DEC-056](DECISIONS.md)). Valkey is a supported alternative. This guide moves a deployment, or the Compose stacks, to Valkey. Facts marked *checked* were measured on 2026-11-06 with Bun 1.4.4, Valkey 9.1.3 and Redis 7.4.12; the test counts in §6 were measured again on 2026-11-07 with Redis 8.10.3 and Valkey 9.1.3. The `AUTH_REDIS_DRIVER=official` facts in §2 and §3.4 were measured on 2026-11-07 with ioredis 5.11.1 and `@better-auth/redis-storage` 1.7.15, on Redis 6.2.24, Redis 8.10.3 and Valkey 9.1.3. Check them again when one of those versions changes.

## 1. When to use it

- The platform offers only a managed Valkey. Openship is one: it has no managed Redis. Dokploy, or any plain `docker compose` deployment, can run either.
- The project decides to run Valkey everywhere (Path B). Record that as a new DEC entry, because it reverses DEC-056's default.

Redis holds nothing that has to be kept, so the move is a configuration change with no data migration (§5).

## 2. Why no code changes

- **What the API sends.** `GET`, `SET … EX [NX]`, `INCR`, `MULTI`/`EXEC`, `GETDEL`, `DEL`, `SCAN` and `PING` ([ARCHITECTURE.md §6](ARCHITECTURE.md)). No modules, no pub/sub. Bun 1.4.4's `RedisClient` opens every connection with RESP3 `HELLO`, and sends `SELECT` when `REDIS_URL` names a database other than 0 (*checked*, §3.4).
- **Lua only with `AUTH_REDIS_DRIVER=official`.** With the default (`custom`) the API sends no Lua. With `official` ([DEC-057](DECISIONS.md)), Better Auth's rate-limit counters go through `@better-auth/redis-storage` on a second connection (ioredis, RESP2, no `HELLO`). Each count is one `EVAL` whose script runs `INCR` and, on the first hit, `EXPIRE`. That connection sends nothing else: `AUTH` when the URL has credentials, `SELECT` when it names a database other than 0, and no `INFO` or `CLIENT SETINFO`. `EVAL`, `INCR` and `EXPIRE` exist on Redis 6.2 and on Valkey (*checked* on Redis 6.2.24, Redis 8.10.3 and Valkey 9.1.3). A server that disables scripting cannot run `official`: the counts then stay in each instance's memory, with a `cache.unavailable` warning every 30 s.
- **The floor.** A server must answer `HELLO` and support `GETDEL`: Redis 6.2 or later, or Valkey. Redis 5 closes the connection, and Redis 6.0.20 connects but has no `GETDEL` (*checked*, DEC-056). Valkey was forked from Redis 7.2.4, so it has both. Only Valkey 9.1.3 has been measured.
- **What stays.** The names stay Redis whichever server runs, so nothing is renamed:
  - the `redis` service key in the Compose files (CI reads `.services.redis.image`),
  - `REDIS_URL`, with its `redis://` or `rediss://` scheme,
  - `REDIS_PORT` (the dev stacks' host port),
  - `utils/redis` and `utils/cache` in the API.
- **The API reads only `REDIS_URL`.** It passes that URL to Bun's client explicitly, so a `VALKEY_URL` variable set by the platform is ignored. Bun also accepts `valkey://` and `redis+tls://`, but the API's environment check refuses every scheme except `redis://` and `rediss://` and stops at startup.

## 3. Path A: managed Valkey on the platform

### 3.1 `REDIS_URL`

```
REDIS_URL=redis://:<password>@<host>:<port>             # password only (the server's default user)
REDIS_URL=redis://<user>:<password>@<host>:<port>       # an ACL user
REDIS_URL=rediss://<user>:<password>@<host>:<port>      # the same, over TLS (§3.2)
```

- Copy host, port and credentials from the platform's connection details. Whatever variable the platform fills, the API reads only `REDIS_URL`.
- Percent-encode reserved characters in the user and the password (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`). An encoded password works (*checked*). Left unencoded, they make the URL unparsable, and the API stops at startup with `REDIS_URL must be a redis:// or rediss:// URL`.
- With `AUTH_REDIS_DRIVER=official` (§2), the URL must have no query string (`?…`): ioredis would read client options from it over the driver's own, so the API stops at startup with `AUTH_REDIS_DRIVER=official needs a REDIS_URL without a query string`.
- An unreachable server, a wrong password, an untrusted certificate and `redis://` sent to a TLS port all look the same from the API: the command fails with `ERR_REDIS_CONNECTION_CLOSED` and `/api/health` reports `"redis": "down"` (*checked*). There is no clearer message, so check each of those by hand when health says `down`.

### 3.2 TLS

Bun 1.4.4's client supports TLS through `rediss://` (*checked* against Valkey 9.1.3 with TLS only, using the API's client options; [Bun's Redis docs](https://bun.com/docs/runtime/redis) list the scheme).

- The API passes no TLS options, so the server's certificate must chain to a CA the API process trusts, and its name must match the host in the URL.
- A certificate from a public CA works as it is.
- For a private CA, set `NODE_EXTRA_CA_CERTS` to its PEM file in the API's environment. Bun honours it for the Redis client (*checked*).

### 3.3 Server settings

Set these if the platform exposes them. They are the Compose stacks' settings, for the same reasons:

| Setting | Value | Why |
|:---|:---|:---|
| `maxmemory` | Sized per deployment; 256 MB is the dev default, not a measured size | Bounds the dataset |
| `maxmemory-policy` | `allkeys-lru` | Every key the API writes has a TTL, so under pressure the least recently used key is evicted instead of writes being refused. An evicted rate-limit counter loses its count and its window restarts. Not `volatile-lru`: it spares only keys without a TTL, and the counters have one, so it protects nothing here |
| Persistence | Off (`save ""`, `appendonly no`) | Not a store of record: module cache entries and rate-limit counters, all with a TTL. Sessions and verification values live in PostgreSQL only (DEC-054, DEC-055). A restart loses nothing that matters |
| `timeout` | `0` (the default) | When the server closes an idle connection, the API's next command on it fails once and the one after reconnects ([ARCHITECTURE.md §6](ARCHITECTURE.md)) |

### 3.4 A restricted user (optional)

If the platform allows ACL users, the API needs only these commands (*checked*: a user with exactly this list connected over TLS and ran them):

```
ACL SETUSER app_api on ><password> resetchannels ~* -@all +hello +auth +ping +get +set +incr +getdel +del +scan +multi +exec
```

If `REDIS_URL` names a database other than 0 (`…/2`), add `+select` to this list or the one below. Without it, Bun's client is refused at connect (`NOPERM … 'select'`) and every command fails. ioredis (`official`) reports the same `NOPERM` as `cache.unavailable` and then counts in database 0, apart from the `custom` driver's counters (*checked* on Redis 8.10.3).

With `AUTH_REDIS_DRIVER=official` (§2), grant `+eval +expire` as well:

```
ACL SETUSER app_api on ><password> resetchannels ~* -@all +hello +auth +ping +get +set +incr +getdel +del +scan +multi +exec +eval +expire
```

- *Checked* on Redis 6.2.24, Redis 8.10.3 and Valkey 9.1.3: a user with exactly this list counted through both drivers.
- Without `+eval`, every count is refused (`NOPERM`) and counts in memory instead.
- **Grant both or neither.** With `+eval` but not `+expire`, the script's `INCR` runs before its `EXPIRE` is refused, and Lua does not roll back. The counter is left with no TTL (*checked*: `TTL` answers `-1` on all three servers). It then never expires and locks its client IP and path out for good, even after switching back to `custom`. Delete such keys by hand (`--scan --pattern 'auth:*'`, then `TTL`, then `DEL` the ones at `-1`).

Module names vary per project, hence `~*`. The test suite in §6 needs five more (`CLIENT`, `ECHO`, `RPUSH`, `EXPIRE`, `TTL`; *checked*: a user with this list and those five passes it), so run it with the platform's admin user, never with this one.

## 4. Path B: Valkey in the Compose stacks

Change the three Compose files. The digest below is a known-good pin (Valkey 9.1.3, Alpine 3.24.3; Trivy 0.69.3 found no vulnerability at any severity in its 23 Alpine packages on 2026-11-06). The server itself is built from source, so Trivy lists no `valkey` package and cannot see its flaws (*checked*): watch Valkey's own security releases. Re-pin to the current patch before you apply it: `docker pull valkey/valkey:<version>-alpine` prints the digest of the multi-arch index (`Digest: sha256:…`).

Use `valkey-server`, not the image's `redis-server` alias. The image's entrypoint drops root (`setpriv` to the `valkey` user) only when the command is `valkey-server`, so under the alias the server runs as root (*checked*). The healthcheck uses `valkey-cli`.

`docker-compose.yml` and `docker-compose.dev.yml` (the same change in both):

```diff
   redis:
-    image: redis:8.10.3-alpine@sha256:71885d8cc6e42f2bc0aa2eb853bfc4be200b5108a46ac50e117ae1df0531fb80
+    image: valkey/valkey:9.1.3-alpine@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b
 …
-    # The image's entrypoint drops root (setpriv to the redis user) only when the command is redis-server, and
-    # then also loads the image's bundled modules (JSON, Search, TimeSeries, Bloom). The API uses none of them.
-    command: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
+    # valkey-server, not its redis-server alias: the image's entrypoint drops root only for that name.
+    command: ["valkey-server", "--save", "", "--appendonly", "no", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
 …
     healthcheck:
-      test: ["CMD-SHELL", "redis-cli ping | grep -q PONG"]
+      test: ["CMD-SHELL", "valkey-cli ping | grep -q PONG"]
```

`docker-compose.test.yml`:

```diff
   redis:
-    image: redis:8.10.3-alpine@sha256:71885d8cc6e42f2bc0aa2eb853bfc4be200b5108a46ac50e117ae1df0531fb80
+    image: valkey/valkey:9.1.3-alpine@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b
-    # The image's entrypoint drops root (setpriv to the redis user) only when the command is redis-server, and
-    # then also loads the image's bundled modules (JSON, Search, TimeSeries, Bloom). The API uses none of them.
-    command: ["redis-server", "--save", "", "--appendonly", "no"]
+    # valkey-server, not its redis-server alias: the image's entrypoint drops root only for that name.
+    command: ["valkey-server", "--save", "", "--appendonly", "no"]
 …
     healthcheck:
-      test: ["CMD-SHELL", "redis-cli ping | grep -q PONG"]
+      test: ["CMD-SHELL", "valkey-cli ping | grep -q PONG"]
```

Keep the `redis` service key, the `127.0.0.1:` port bindings and the `tmpfs` mounts. Also update the header comments of `docker-compose.yml` and `docker-compose.dev.yml`, which name the server.

**CI.** In `.github/workflows/ci.yml`, rename the step "Scan the Redis image" to "Scan the Valkey image" and change the two comments that name Redis as a scanned image (the `security` job's header and the step "Read the registry images from the test stack"). The step still reads `jq -er '.services.redis.image'`, so it scans whatever `docker-compose.test.yml` names. Then run Trivy on the new pin as [TESTING.md §6.2](TESTING.md) describes ("Run it locally", the image variant) and record the result in its waiver table. A fixable CRITICAL or HIGH finding needs a newer patch first, and a waiver only under the rules in that section.

**Documents.** Change the places that name the server: README.md (prerequisites), `.env.example` (the `REDIS_URL` comment), [ARCHITECTURE.md](ARCHITECTURE.md) §1, §2 and §6, [PRD.md](PRD.md) (stack table and constraints), [TESTING.md](TESTING.md) §6.2 (the scan table, the waiver table and "Not covered"), and the new DEC entry.

**Check.** `docker compose -f <file> config` for each file, then `docker compose -f docker-compose.test.yml up -d --wait redis` (healthy proves the `valkey-cli` healthcheck), then the test suite of §6 against it, then `bun run typecheck` at the root and `bun test` in `apps/api`. A running dev container keeps its old image until it is recreated.

## 5. Cutover

1. Provision the Valkey server and apply §3.3.
2. Run the test suite (§6, step 1) against it.
3. Set `REDIS_URL` to the new server and restart or redeploy the API. Each instance reads `REDIS_URL` once, at startup.
4. Verify (§6, steps 2 and 3).

No data is migrated. Redis holds module cache entries, Better Auth rate-limit counters (`auth:` keys) and per-user rate-limit counters (`ratelimit:` keys), all with a TTL. Sessions and verification values live only in PostgreSQL (DEC-054, DEC-055), so nobody is signed out.

What users notice:

- **Rate-limit windows restart.** Counts begin again at zero on the new server: for one window a client gets a fresh allowance (sign-in: 5 per 60 s). While instances are rolled one by one, the old and the new server count separately, so a client can briefly get up to twice the limit.
- **The module cache starts cold.** The first reads go to PostgreSQL and are slower until the cache has warmed.

If the API cannot reach the new server:

- Better Auth's rate limiter fails open: it counts in a bounded per-instance memory counter and emits `cache.unavailable`, so sign-in, sign-up and sign-out keep working (DEC-055). The per-user limits on module routes do the same ([ARCHITECTURE.md §10](ARCHITECTURE.md)).
- What module caches and `/api/health` do is described in [ARCHITECTURE.md §6](ARCHITECTURE.md). Read it before the cutover.

## 6. Verification

1. **The test suite against the target.** Run it against the new server before cutover or, after an upgrade, against a staging instance of the same version. From `apps/api`, on a machine that can reach it:

   ```bash
   TEST_REDIS_URL='rediss://<admin-user>:<password>@<host>:<port>' bun test tests/utils/cache tests/utils/redis
   ```

   With `AUTH_REDIS_DRIVER=official`, run `tests/utils/auth/redis-driver.test.ts` against it as well. Its real-server tests write `auth:test-<uuid>…` keys, because the driver puts `auth:` in front of every key, and delete them afterwards. The counts below are for the two folders above only.

   - The suites leave other data alone. They write only `test-<uuid>` keys and delete what they wrote. They never run `FLUSHDB` or `FLUSHALL`. Their `CLIENT KILL` names their own connection by ID, so other clients keep theirs.
   - Other clients' commands do not change what they count. The tests that check which commands the API sends (`EXEC` and never `EVAL` or `EVALSHA`, `SCAN` and never `KEYS`) count only their own, recorded on the way by `createReplyDroppingProxy` (`tests/helpers/redis.ts`), not the server-wide `INFO commandstats` (*checked*: they pass while another client floods the server with `EVAL` and `KEYS`).
   - They run under the API's 1 s deadlines, and one test fits 2000 increments into one. Run them from a machine on the server's network, where the API will run, while no other client keeps the server busy: one slow command, such as `KEYS` on a large keyspace, stalls every client.
   - They need `CLIENT`, `ECHO`, `RPUSH`, `EXPIRE` and `TTL` besides the API's commands (§3.4). A managed service that blocks any of them for the admin user fails more tests.
   - They skip, not fail, when nothing answers at `TEST_REDIS_URL`. A `skip` in the output means the server was not reached.
   - Add `NODE_EXTRA_CA_CERTS` for a private CA (§3.2).
   - The tests that lose replies on purpose reach the server through `createReplyDroppingProxy`. It connects with the URL's user, password and database, and over TLS for `rediss://`, so it needs nothing extra.
   - Expected: 149 pass, 0 fail, 0 skip (*checked*; 27 of those tests need a real server), on each of:
     - Redis 8.10.3 with no password and no TLS,
     - Valkey 9.1.3 with a password, as the default user and as an ACL user,
     - Valkey 9.1.3 over TLS with a private CA (`NODE_EXTRA_CA_CERTS`), as an ACL user.
   - **Any failure is real.** Stop and find its cause before you go on.
2. **Health.** `GET /api/health` answers 200 with `"redis": "up"`.
3. **One sign-in.** Sign in once (`POST /api/auth/sign-in/email`, or through the web app). The rate-limit counter for it must exist on the new server, with a TTL of at most 60 s:

   ```bash
   valkey-cli -u "$REDIS_URL" --scan --pattern 'auth:*'
   valkey-cli -u "$REDIS_URL" TTL '<a key from the scan>'
   ```

   For TLS add `--tls`, and `--cacert <file>` for a private CA.

   The key is `auth:<client ip>|/sign-in/email`. No `cache.unavailable` event should appear in the log.

## 7. Rollback

Point `REDIS_URL` back at the old server and restart the API. Nothing is lost: the old server never held a record. As at cutover, rate-limit windows restart and the module cache starts cold. For Path B, revert the Compose, CI and document changes and recreate the `redis` containers.
