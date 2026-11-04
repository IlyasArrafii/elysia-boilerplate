# FEATURES.md

User-facing features with stories, acceptance criteria and edge cases. HTTP details are in [API.md](API.md); roles and permissions in [auth/access/static-roles.md](auth/access/static-roles.md); tests in [TESTING.md](TESTING.md).

## 1. Feature list

| ID | Feature | API module | Web feature | Priority |
|:---|:---|:---|:---|:---|
| F-01 | Email/password sign-up and sign-in | Better Auth (`auth`) | `auth` | P0 |
| F-02 | Google sign-in | Better Auth (`auth`) | `auth` | P0 |
| F-03 | User and role management | admin plugin + `admin` | `admin` | P0 |
| F-04 | Example module: posts (RBAC + cache) | `posts` | `posts` | P0 |
| F-05 | Session in the web app, profile | Better Auth, `me` | `auth`, `profile` | P0 |
| F-06 | Observability | `utils/logger`, `utils/telemetry` | — | P0 |
| F-07 | Test structure | all | all | P0 |

## 2. F-01: Email/password

**Stories**
- As a guest, I want to sign up with email and password so I can use authenticated pages.
- As a user, I want to stay signed in across refreshes.
- As a user, I want to sign out so my session ends.

**Acceptance criteria**
- Given valid input, `POST /api/auth/sign-up/email` creates a user with role `user` and a hashed password.
- Given correct credentials, `POST /api/auth/sign-in/email` sets a session cookie.
- After `POST /api/auth/sign-out`, a protected route returns 401.
- A duplicate email is rejected with Better Auth's error (recorded in [auth/README.md §5](auth/README.md)).
- The sixth sign-in attempt from one IP within 60 seconds returns 429.

**Edge cases**
- Password shorter than 8 characters → validation error, nothing created.
- Unknown email or wrong password → the same generic error (no account enumeration).
- Expired session → 401; the web app redirects to `/login`.
- Banned user signs in → Better Auth's banned error.

## 3. F-02: Google

**Stories**
- As a guest, I want to sign in with Google so I don't need a password.
- As a new Google user, I want an account created automatically.

**Acceptance criteria**
- `POST /api/auth/sign-in/social` with `provider: "google"` returns a Google redirect URL (PKCE and state included).
- `GET /api/auth/callback/google` creates or links the user and sets the session cookie.
- A new Google user gets role `user`.
- A Google sign-in whose verified email matches an existing password account links to it (one user, two `account` rows) and emits `audit.account.linked`.

**Edge cases**
- State or PKCE mismatch → error shown on `/login`.
- User cancels at Google → back to `/login` with a message, no account created.

## 4. F-03: User and role management

**Stories**
- As a Super Admin, I want to change a user's role, ban a user and revoke their sessions.
- As an Admin, I want to list users and see their sessions.
- As an Admin or Super Admin, I want to see what each role can do.

**Acceptance criteria**
- `super_admin` changes a role with `authClient.admin.setRole`; the next request uses the new permissions; `audit.user.role_changed` is emitted.
- `admin` and `user` get 403 on set-role, ban, remove and revoke (DEC-033).
- `admin` can list users, get a user and list a user's sessions.
- Nobody can change their own role: `400 CANNOT_CHANGE_OWN_ROLE`. A role not in the registry: `400 INVALID_ROLE`.
- Banning revokes all the user's sessions immediately and emits `audit.user.banned`.
- `GET /api/admin/roles` (`role:read`) returns every registry role with its compiled permissions.
- The admin plugin's impersonation endpoints return 404 for every role (DEC-032).

**Edge cases**
- Target user does not exist → Better Auth's not-found error.
- Ban or delete yourself → `400 CANNOT_TARGET_SELF`.
- A user holding a role removed from code → no permissions, `rbac.unknown_role` warning at startup.

## 5. F-04: Posts

**Stories**
- As a user, I want to list and read posts, create posts, and edit or delete my own.
- As an admin, I want to edit or delete anyone's post.

**Acceptance criteria**
- `GET /api/posts` (`posts:read`) returns a paginated list, cached under `posts:list:{page}:{limit}` (stored as `posts:list:{generation}:{page}:{limit}`, see API.md, TASK-08).
- `POST /api/posts` (`posts:write`) validates `title` ≥ 3 and `content` ≥ 10 chars, creates the post with the caller as author, returns 201, clears `posts:list:*`.
- `GET /api/posts/:id` returns the post or `404 POST_NOT_FOUND`.
- PATCH and DELETE: author succeeds; another `user` → 403; `admin` (`posts:manage_all`) succeeds.
- A cache hit returns exactly the same payload as a miss; p95 on a hit < 50 ms.
- Any error inside these routes is logged with `module: "posts"`.

**Edge cases**
- Redis unavailable in dev → memory fallback, one `cache.fallback` warning, requests succeed.
- Payload over the max length → `400 VALIDATION_ERROR` with field paths only.
- `limit` > 100 → 400.

## 6. F-05: Session in the web app and profile

**Acceptance criteria**
- `useSession()` provides the session app-wide.
- `/login`, `/register` and the OAuth return path work; success redirects to `/`.
- Login and register forms use TanStack Form and validate email format and password length before submit. Each check is a field's `onSubmit` validator from `features/auth/lib/validation.ts` (`@tanstack/react-form` 1.33.5). Better Auth codes about one input are shown on that field: `INVALID_EMAIL` and `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` on Email, `PASSWORD_TOO_SHORT` and `PASSWORD_TOO_LONG` on Password. A rejected sign-in (401), a 429 and every other failure stay one alert above the form (TASK-10).
- Sign-out calls Better Auth sign-out and clears the TanStack Query cache.
- Protected pages without a session redirect to `/login` in `beforeLoad`; pages needing a missing permission redirect to `/` with a message.
- The profile page updates `name` and `image` through `updateUser`. `/profile` (session only) sends both fields, trimmed, with an empty image as `null`. Better Auth 1.7.15 sets no limits on either field, so the client only refuses an empty name; any image value is sent as typed. The page previews the image only when it is an http(s) address (absolute or on this site) or a `data:image/` URL. Both inputs are read-only while a save is in flight. On success the session query is updated in place, only if it still holds the user who submitted, and then re-read from the API; a failed re-read still counts as saved. A 401 drops the local session, which sends the page to `/login?redirect=/profile` (TASK-10).

**Edge cases**
- OAuth failure → error alert on `/login`.
- Double submit → one request.

## 7. F-06: Observability

**Acceptance criteria**
- Every request produces one `http.request` event with `requestId` and `module`, written to stdout and (when `LOG_MONGO_URL` is set) to MongoDB.
- Every error produces one `http.error` event identified by `module` and `code`, with the stack in the log only.
- Audit events are emitted for sign-in, sign-out, role change, ban and Google linking.
- No secret or personal data appears in any log line or stored document.
- `bun run logs:prune --dry-run` reports what would be deleted per kind; without `--dry-run` it deletes events older than their retention.
- Details: [observability/README.md §10](observability/README.md), [redaction.md §7](observability/redaction.md), [log-storage.md §8](observability/log-storage.md).

## 8. F-07: Test structure

**Acceptance criteria**
- Every API module has `apps/api/tests/modules/<module>/` and, where it has routes, `apps/api/tests/e2e/<module>/`.
- Every web feature has `apps/web/tests/features/<feature>/` and, where it has pages, `apps/web/e2e/<feature>/`.
- Required tests per level in [TESTING.md](TESTING.md).

## 9. Out of scope

See [PRD.md §5](PRD.md).
