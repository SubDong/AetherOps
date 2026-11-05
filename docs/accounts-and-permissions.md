# Accounts, Roles and Permissions

**English** · [简体中文](./accounts-and-permissions.zh.md)

AetherOps is multi-account by design: it hands an AI agent (and therefore natural language) a real
shell on your servers, so "who is allowed to do which dangerous thing" is a first-class concern
rather than an afterthought.

- [Model](#model)
- [The ten permission bits](#the-ten-permission-bits)
- [Registration and approval](#registration-and-approval)
- [Tokens and sessions](#tokens-and-sessions)
- [Data isolation](#data-isolation)
- [Admin oversight](#admin-oversight)
- [Credential handling](#credential-handling)
- [Rules for changes](#rules-for-changes)

## Model

| Concept | Values | Notes |
|---------|--------|-------|
| `role` | `admin`, `user` | `admin` governs accounts and may use the oversight endpoints. It is **not** a bypass of permission bits for normal features |
| `status` | `pending`, `active`, `disabled` | `pending` can log in but sees a "waiting for approval" state; `disabled` cannot log in at all |
| `permissions` | 10 booleans | Checked per endpoint on every request |
| `username` | `[A-Za-z0-9_.-]{3,32}` | |
| `displayName` | free text, truncated to 64 | |
| `password` | 8–128 chars, `scrypt` hash | Format `scrypt$N$r$p$salt$hash` |

The initial administrator is created when the `users` table is empty: username `admin`, a random
16-character password (ambiguous glyphs excluded) printed once in the startup log. There are no
other seeded accounts and no default passwords.

## The ten permission bits

| Bit | Grants | Column |
|-----|--------|--------|
| `terminal` | Open and drive SSH/local terminals | `can_use_terminal` |
| `batch` | Fan a command out to many sessions at once | `can_use_batch` |
| `ai` | Chat with the agent, run skills that execute commands | `can_use_ai` |
| `connections` | Create/edit/delete stored connections | `can_manage_connections` |
| `aiConfig` | Read and edit AI provider profiles | `can_configure_ai` |
| `files` | SFTP file manager and transfers | `can_use_files` |
| `monitor` | Log monitoring and alerts | `can_view_monitor` |
| `audit` | Read audit history | `can_view_audit` |
| `skills` | List and inspect skills | `can_manage_skills` |
| `snippets` | Command snippets library | `can_manage_snippets` |

Endpoint mapping lives in one table in `server/index.ts` (`EXACT_PERMISSIONS` for exact paths,
`PREFIX_PERMISSIONS` for prefixes). Semantics worth understanding before you file a bug:

- **"any of" not "all of"**: some endpoints accept several bits, because the file manager and the
  terminal share the same underlying SSH session — a person with `files` but not `terminal` should
  still be able to browse.
- **Unlisted endpoints require login only.** The fallback is deliberately "under-block rather than
  break a feature", so an unregistered new endpoint is reachable by any signed-in account. When you
  add an endpoint, add it to the table.
- **`batch` was split out of `terminal`** (migration `0005`) because one command hitting N hosts has
  a much larger blast radius. Existing accounts inherited `can_use_batch = 1` only where they already
  had terminal access; revoke it per account in the admin UI if you want the tighter default.
- **Session ownership is checked separately**: any request carrying a `sessionId` is rejected if that
  live session belongs to another account, regardless of permission bits. Terminal IDs are
  client-generated, so guessing one must not buy you someone else's shell.

## Registration and approval

Two ways to get an account:

1. **Self-service register** (link on the login page): creates `role=user`, `status=pending`,
   **all permissions off**. The person can sign in and wait; nothing is usable until an admin grants
   bits. This is the safe default for a shared deployment with an open signup link.
2. **Admin creates** it: `status=active` immediately, with whatever permission set you choose; if
   you leave the password empty a random one is generated and shown once in the response.

`/api/auth/register` is on the public path list and **there is no configuration switch to turn
registration off**. A pending account cannot do anything, so this is not a privilege hole, but it does
mean anyone reachable can create rows in your `users` table and learn that a username exists. On an
instance reachable beyond your network, block `/api/auth/register` at the reverse proxy and let admins
create accounts instead.

Admin actions in **account menu → user management** (`/users`, admin-only route):

- change display name, role, status, and the permission checkboxes,
- reset a password (generates a new one),
- delete an account,
- force a user offline.

Two guards protect you from locking yourself out:

- an admin editing **their own** account cannot change their own `role` or `status` through the
  update endpoint (only display name and permissions), so "demote self and lose the console" is not
  one click away;
- the **last usable admin** cannot be demoted or disabled — the request fails with 409.

## Tokens and sessions

```
POST /oauth/token   grant_type=password  → access_token, expires_in, user (permissions snapshot)
POST /api/auth/login                      → same handler, JSON or form encoded
POST /oauth/revoke                        → revoke current token (logout)
POST /api/auth/me                         → re-read the account row (fresh permissions)
POST /api/auth/register                   → self-service signup, lands as pending
POST /api/auth/changePassword             → change own password, then forces re-login
POST /api/users/*                         → admin-only account management
```

The JSON business routes are **POST-only**: `app.use('/api/')` handles `POST` and calls `next()`
for anything else, so a `GET /api/connections` falls through to the SPA instead of returning data.
The three file-transfer endpoints (`/api/file-upload`, `/api/cwd`, `/api/file/download`) are
separate HTTP routes registered before that middleware, because they stream binary payloads rather
than JSON, and they perform their own permission + session-owner check. `/oauth/token` responses
carry `Cache-Control: no-store` so an intermediary cannot cache and replay a token.

- Tokens are `ao_` + 32 random bytes (base64url). Redis stores only a **hash** of the token as the
  key, with the payload (userId, role, status, permission snapshot) as the value.
- TTL is 7200 s, **sliding**: each authenticated request extends it when less than 1000 s remain,
  done in one Lua script together with the account index so the renewal cannot race.
- **One active session per account**: issuing a token deletes the previous one atomically. A second
  login from another machine kicks the first; the front-end distinguishes this (`session_replaced`)
  from a plain expiry.
- Any admin change that affects "can this be used" (role / status / permissions) revokes the target's
  token immediately, because the token carries a snapshot — otherwise the session would keep running
  with stale privileges.
- Password verification runs a scrypt against a dummy hash when the username does not exist, so a
  missing account and a wrong password take similar time and return the same message.
- The WebSocket uses the same token (`?token=` on `/ws/terminal`, since browsers cannot set headers
  there). Before any session can be created the handshake checks the **origin allow-list**, then the
  token, then requires the `terminal` permission and closes with `1008` on any failure. Messages that
  arrive during the (possibly slow, remote) Redis lookup are buffered and replayed in order rather
  than dropped, and every `sessionId` in a message is owner-checked — except `create`.
- Deleting an account (admin action) revokes its token, **purges owner-scoped rows** and removes the
  user record. There is no soft delete or recycle bin for accounts, so it is irreversible.

## Data isolation

Every business query takes `owner_id` explicitly. There is no "current user" stored on a service
instance — the services are process-global and shared by all accounts, so an implicit "current" would
leak the previous request's identity.

Concretely: connections, sessions, AI profiles, chats, messages, usage, budgets, audit events,
snippets and user skills are all keyed by account. Two accounts cannot see each other's servers,
prompts or transcripts, even though they share one MySQL schema.

## Admin oversight

Admins can look **into** member data. This is the single deliberate exception to isolation, so it is
restricted to explicitly role-checked endpoints (not the generic permission table) and each one
requires a `userId` argument:

| Endpoint | Returns |
|----------|---------|
| `/api/admin/memberAudit` / `memberAuditDates` | A member's command audit trail |
| `/api/admin/memberTransfers` | File upload/download records (path, bytes, duration, result) |
| `/api/admin/memberConnections` | Connection inventory — **with `password` / `privateKey` / `passphrase` stripped** and only a `hasSecret` flag left |
| `/api/admin/memberSessions` | A member's live terminal sessions |
| `/api/admin/disconnectUser` | Close all of a member's sessions |

If you extend this set, keep the stripping rule: secret material never appears in a non-owner view.
An oversight list that leaks credentials turns governance into an exposure.

## Credential handling

| Secret | At rest | Key location |
|--------|---------|--------------|
| Account passwords | `scrypt` hash, irreversible | n/a |
| SSH passwords, private keys, passphrases | `enc:v1:` AES-256-GCM in MySQL | `~/.aetherops/connections.key` |
| AI provider API keys | `enc:v1:` AES-256-GCM in MySQL | `~/.aetherops/ai-config.key` |
| Login tokens | SHA-256 hash used as the Redis key | n/a |

Consequences to plan for:

- The `.key` files are the secrets. Back them up, and keep them out of database exports.
- Losing the data directory means losing stored credentials (they cannot be decrypted).
- A DB dump plus the data directory equals full exposure of stored SSH credentials — that is the
  normal trade-off for a credential store; protect both halves.

## Rules for changes

If you modify authorization behavior:

1. Keep permission checks in `assertPermission` / `assertAdmin` / `assertSessionOwner` — one funnel,
   not scattered `if`s inside services.
2. New business tables need `owner_id` in the primary key (or an equivalent scoping column) **and**
   no default value, so a forgotten owner fails loudly instead of writing rows nobody can read.
3. Migrations must be re-entrant (wrap `ALTER` in an `information_schema` check + `PREPARE`): the
   migrator re-runs a failed migration on next start.
4. `node scripts/verify-auth.mjs` against a running instance is the regression net for login,
   pending restrictions, permission enforcement, data isolation, single-session takeover, sliding
   renewal and delete-account invalidation. Run it after touching any of these areas.
5. Do not add a way to disable authentication. The old `auth.disabled` / `auth.accessToken` knobs are
   intentionally dropped and warned about; local development uses real accounts too.
