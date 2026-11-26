# Configuration Reference

**English** · [简体中文](./configuration.zh.md)

AetherOps has exactly one configuration file, one environment-variable namespace, and a small set of
files in the data directory that you need to know about before operating it.

- [Where configuration lives](#where-configuration-lives)
- [Precedence](#precedence)
- [`config.json` sections](#configjson-sections)
- [Environment variables](#environment-variables)
- [Storage layout](#storage-layout)
- [Database schema and migrations](#database-schema-and-migrations)
- [What is stored where](#what-is-stored-where)
- [Backup and move](#backup-and-move)
- [Storage backends: lite (SQLite) vs enterprise](#storage-backends-lite-sqlite-vs-enterprise)

## Where configuration lives

| Case | Source of truth |
|------|-----------------|
| Default | `~/.aetherops/config.json` — created automatically on first run with mode `0600` |
| Explicit file | `AETHEROPS_CONFIG=/path/to/config.json` (absolute, or relative to the working directory) |
| Custom data dir | `AETHEROPS_DATA_DIR=/data/aetherops` (the default `config.json` location follows it) |

Notes that matter operationally:

- The data directory location is decided **only** by `AETHEROPS_DATA_DIR` or the `~/.aetherops`
  default. `config.json` cannot relocate the directory it lives in — that would be circular.
- If `AETHEROPS_CONFIG` points at a missing file, startup **fails** instead of generating a template.
  An explicit path means "I believe this file exists"; silently creating an empty one produces the
  hardest kind of bug: "the config loaded, but every value is a default".
- A file that is not valid JSON aborts startup. Unknown sections and unknown keys are reported and
  dropped, so a typo cannot half-work.
- `auth.disabled` / `auth.accessToken` are removed from the old single-token scheme; they are read,
  discarded and reported as deprecated. Authentication is the account system's job now.

## Precedence

```
built-in defaults   <   config file   <   environment variables
```

So a container image can be re-pointed at a different database with env vars alone, while a
password written into the file survives restarts. Values are coerced: `"3306"` is accepted for a
number, `"true"` / `"1"` for a boolean; anything mismatched is ignored with a warning.

## `config.json` sections

### `server`

| Key | Default | Meaning |
|-----|---------|---------|
| `port` | `9802` | HTTP/WS listen port. CLI `--port` and `PORT` win over this |
| `host` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind auth + a network you control. Env: `HOST` (preferred) or `AETHEROPS_HOST` |

### `storage`

Decides where data lands. **A personal / single-host deployment needs neither MySQL nor Redis**: leave
this section alone and one SQLite file holds accounts, connections, audit, metrics, alerts and login
tokens.

| Key | Default | Meaning |
|-----|---------|---------|
| `mode` | `auto` | `auto` / `enterprise` / `lite`. `auto` = enterprise when any of `database.host`, `redis.host`, `redis.url` is set, lite when all are empty |
| `sqlitePath` | *empty* | SQLite file path. Empty = `aetherops.db` in the data directory; relative paths resolve against it |
| `busyTimeoutMs` | `5000` | Write-lock wait budget (ms). Lets the server and `pnpm migrate` queue on the same file instead of failing with `SQLITE_BUSY` |

`mode: auto` exists so **existing deployments do not change behaviour on upgrade**: an instance whose
config already has `database.host` keeps using MySQL + Redis, and only a fresh install with nothing
filled in lands on SQLite. Writing `lite` explicitly makes `database` / `redis` ignored with a startup
warning — no "thinks it is on the remote DB but has been writing a local file all along".

The two modes **cannot be swapped later**: the data is not compatible and there is no built-in
MySQL → SQLite migration tool. Switching means starting from an empty store.

### `database`

Only used when `storage.mode=enterprise` (under `auto`, decided by whether `database.host` is set).

| Key | Default | Meaning |
|-----|---------|---------|
| `host` | *empty* | MySQL host. Empty is reported as a config error at startup |
| `port` | `3306` | |
| `user` / `password` | *empty* | Least-privilege account; needs DDL unless you apply SQL manually. **A non-empty password is mandatory** — an empty one is treated as "not configured" and aborts startup, so a passwordless local `root` will not work |
| `database` | `aetherops` | Schema name |
| `connectionLimit` | `5` | Pool size. Kept small deliberately: a shared instance with `max_connections=50` cannot afford 10 per host app |
| `connectTimeoutMs` | `10000` | |
| `charset` | `utf8mb4` | |
| `timezone` | `+00:00` | Driver-side interpretation. Timestamps are written by the app as JS `Date` (UTC); the schema never uses `NOW()`/`CURRENT_TIMESTAMP` because the test instance ran `system_time_zone=CST` and would have shifted everything by 8 hours |
| `ssl` | `false` | Enable TLS |
| `sslRejectUnauthorized` | `false` | Strict certificate verification. Ubuntu's MySQL ships a self-signed cert with no CA, so strict mode fails by default; the connection is still encrypted but not MITM-proof |
| `sslCaPath` | *empty* | Provide a CA to verify against |

Validation rules that abort startup: `sslCaPath` set while `ssl=false` (the CA would be ignored);
CA path that does not exist; `ssl` + `sslRejectUnauthorized` without a CA (guaranteed handshake
failure against self-signed servers); port or `connectionLimit` outside their legal ranges.

The template file also carries a `_comment` key (Chinese) that explains what the file is for. It is
ignored by the loader, and so is any other unrecognized key — with a warning, never silently.

### `redis`

Only used when `storage.mode=enterprise`: in lite mode login tokens live in the SQLite `auth_sessions`
table and Redis is never contacted.

| Key | Default | Meaning |
|-----|---------|---------|
| `url` | *empty* | Full connection string `redis://:pass@host:6379/0`; when set, the fields below are ignored |
| `host` | *empty* | Required (else config error) |
| `port` | `6379` | |
| `username` | *empty* | Redis 6 ACL user; leave empty for password-only auth |
| `password` | *empty* | Empty means "no password"; a startup warning is printed in case the server does require one |
| `db` | `0` | Logical database 0–15 |
| `keyPrefix` | `aetherops:` | Namespacing when the instance is shared; must not be empty |
| `connectTimeoutMs` | `5000` | |

### `auth`

| Key | Default | Meaning |
|-----|---------|---------|
| `launchToken` | *empty* | Health-check token injected by the VSCode/Electron host so `/health` cannot be satisfied by an unrelated process squatting on the port. Not a user identity |
| `maxUploadMb` | `100` | Per-request upload cap; also sizes the WebSocket `maxPayload` |
| `tokenTtlSeconds` | `7200` | Login token lifetime in seconds. Sliding renewal, threshold = a quarter of it (capped at 1000 s, floored at 30 s). Values below 60 are rejected at startup |
| `watchTokenTtlSeconds` | `2592000` | Fixed lifetime of a wallboard read-only token (30 days by default), **never renewed**; `0` disables issuing |

Both TTLs only decide "how long a token stays usable" and have nothing to do with permissions. One reminder:
raising `tokenTtlSeconds` past a day does not make a wallboard happier — a screen should use a read-only
watch token (see [Accounts, Roles and Permissions](./accounts-and-permissions.md#read-only-watch-tokens))
instead of stretching a login session to a week.

### `debug`

| Key | Default | Meaning |
|-----|---------|---------|
| `sshDebug` | `false` | Forward ssh2 protocol-level debug output into the front-end terminal |

### `metrics`

| Key | Default | Meaning |
|-----|---------|---------|
| `offlineSampling` | `false` | Also sample hosts that have **no** open terminal, by dialing them from their saved connection |

What the switch changes: the per-minute metrics collector normally walks the list of live sessions and
never opens a connection by itself, so an idle host has no history for that period. With
`offlineSampling: true` a host nobody is connected to is sampled through a one-shot SSH channel built
from its connection config — one handshake per host per minute, up to 2 hosts in parallel, 45 s of
total round budget, with exponential backoff (1→2→4→8→15 min; 30 min and up when authentication
fails) after errors. Hosts that do have a live terminal keep using it, so the switch adds logins only
for the hosts that would otherwise be skipped.

Be aware of the side effect before turning it on: this is a real SSH login every minute, so the
target's `sshd` will show it in its auth log. To exclude a single host, set that connection's
`sampling` to `skip` (see [Database schema](#database-schema-and-migrations)); it does not affect
opening a terminal to that host or the status panel.

The collector still follows the connection's `host`, so for a jump-host connection (one with a
`startupScript` that hops onward) the recorded history describes the machine AetherOps actually
connects to — the jump host itself, exactly like the status panel. The hop is not reproduced.

The questions that come up before enabling it — why it is off by default, which machine a jump-host
connection samples, why a failing host is not retried every minute, and how to exclude a single
connection — are answered at length in [offline-sampling-faq.md](./offline-sampling-faq.md).

### `alerts`

| Key | Default | Meaning |
|-----|---------|---------|
| `webhookUrl` | *empty* | Receiver for alert notifications. Empty = alerts are stored and shown in the UI, nothing is pushed |
| `webhookSecret` | *empty* | HMAC-SHA256 key for `X-AetherOps-Signature`; empty = unsigned requests (a warning is logged at startup) |
| `webhookTimeoutMs` | `5000` | Per-attempt request timeout in milliseconds |

Only **new** alerts and **level escalations** are pushed. A repeated hit of an unresolved
fingerprint only bumps `occurrences`, it does not page anyone again. Delivery is debounced per
fingerprint for 5 minutes, retried after 30 s / 2 m / 10 m (three retries, four attempts total),
and never blocks the log monitor — an unreachable receiver produces one warning in `server.log`.

Signature header: `X-AetherOps-Signature: sha256=<hmac-sha256(secret, "<x-aetherops-timestamp>.<raw body>")>`.
The timestamp is part of the signed string, so a captured request cannot be replayed later.

Rule-level silence (the **Mute** menu in the Alerts tab, stored in `alert_mutes`) only suppresses
delivery. Matching lines are still counted while muted, so you can see what happened during the
silent window once it expires.

Ownership and grouping sit beside the alerts and have **no keys in this section** — there is nothing
to configure:

- **Claim** acknowledges a row and assigns it to you in one step; **Assign** moves only the assignee
  and keeps the first acknowledger, because those are two different facts. The member list is the
  account's `active` users; assigning to a disabled account is refused.
- **On-call** (`alert_oncall`) is a roster of account + minute-of-day window, `start > end` crossing
  midnight, half-open at both ends (a shift ending at 08:00 hands over to the one starting at
  08:00). It changes exactly one thing: the webhook body carries `onCall` (`userId`, `username`,
  `displayName`, `mention`) for whoever is on duty when the alert fires. Delivery, debounce and
  retries are unchanged and no second channel is opened — whether to page, mail or post to IM is the
  receiver's decision.
- **Incidents** (`incidents`) group alerts by host: three unresolved alerts on one connection within
  30 minutes become one incident, later hits on that host join it, other rows can be attached by
  hand, and it closes when its last attached alert is resolved. This is a heuristic and not a
  diagnosis — the window and the threshold are constants in
  `server/db/repositories/incident.repo.ts`, not configuration.

`loadConfig` caches the file in-process and nothing watches it: **restart the server after editing
this section or the `AETHEROPS_ALERTS_*` variables**. The same applies to every other section here.

## Environment variables

| Variable | Maps to | Notes |
|----------|---------|-------|
| `PORT` | `server.port` | Server reads only `PORT` here |
| `HOST` / `AETHEROPS_HOST` | `server.host` | `HOST` takes precedence |
| `AETHEROPS_DATA_DIR` | data directory | Disables the legacy `~/.aicmd` auto-migration |
| `AETHEROPS_STORAGE_MODE` | `storage.mode` | `auto` / `enterprise` / `lite`; `lite` drops the MySQL / Redis dependency entirely |
| `AETHEROPS_SQLITE_PATH` | `storage.sqlitePath` | SQLite file path (relative paths resolve against the data directory) |
| `AETHEROPS_SQLITE_BUSY_TIMEOUT_MS` | `storage.busyTimeoutMs` | Write-lock wait budget (0–60000) |
| `AETHEROPS_CONFIG` | config file path | Missing file = fatal |
| `AETHEROPS_DB_HOST` / `AETHEROPS_DB_PORT` / `AETHEROPS_DB_USER` / `AETHEROPS_DB_PASSWORD` / `AETHEROPS_DB_NAME` | `database.*` | Avoid putting secrets on disk |
| `AETHEROPS_DB_POOL_SIZE` / `AETHEROPS_DB_SSL` / `AETHEROPS_DB_TZ` | `database.connectionLimit` / `.ssl` / `.timezone` | |
| `AETHEROPS_DB_SSL_CA` | `database.sslCaPath` | |
| `AETHEROPS_DB_SSL_INSECURE` | `database.sslRejectUnauthorized` (inverted) | Named "INSECURE" so the meaning survives a copy-paste |
| `AETHEROPS_REDIS_URL` / `_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB` / `_PREFIX` / `_CONNECT_TIMEOUT_MS` | `redis.*` | |
| `AETHEROPS_MAX_UPLOAD_MB` | `auth.maxUploadMb` | |
| `AETHEROPS_AUTH_TOKEN_TTL_SECONDS` | `auth.tokenTtlSeconds` | Login token lifetime; below 60 is rejected |
| `AETHEROPS_AUTH_WATCH_TOKEN_TTL_SECONDS` | `auth.watchTokenTtlSeconds` | Wallboard token lifetime; `0` disables issuing |
| `AETHEROPS_LAUNCH_TOKEN` | `auth.launchToken` | Set by desktop/VSCode hosts |
| `AETHEROPS_SSH_DEBUG` | `debug.sshDebug` | `1` or `true` |
| `AETHEROPS_METRICS_OFFLINE_SAMPLING` | `metrics.offlineSampling` | `1` or `true`; samples hosts without an open terminal |
| `AETHEROPS_ALERTS_WEBHOOK_URL` / `_WEBHOOK_SECRET` / `_WEBHOOK_TIMEOUT_MS` | `alerts.*` | Receiver, HMAC key and per-attempt timeout |
| `AETHEROPS_NODE` | — | Node binary used to launch the backend (VSCode host) |
| `AETHEROPS_BUNDLED` | — | Set at build time by `scripts/prepare-vscode-runtime.mjs`; do not set by hand |
| `AETHEROPS_VSCODE_PRUNE_PREBUILDS` | — | `1` trims node-pty prebuilds to the current platform |
| `VITE_PORT` | — | Dev-server port only (default 9801) |

AI provider settings (base URL, key, model) are **not** configurable through env: they are
per-account data stored in the database, edited in the UI. There is no `OPENAI_API_KEY` lookup.

## Storage layout

```
~/.aetherops/                       # or $AETHEROPS_DATA_DIR
├── config.json          0600       # the only config file; template auto-created
├── connections.key                  # AES-256-GCM key for SSH passwords / private keys / passphrases
├── ai-config.key                    # AES-256-GCM key for AI provider API keys
├── server.log                       # backend log (console output is tee'd here)
├── aetherops.server.<port>.pid      # written on listen, removed on SIGINT/SIGTERM
├── aetherops.db                     # lite only: SQLite main file (accounts, connections, audit, tokens…)
├── aetherops.db-wal                 # lite only: WAL write-ahead log (merged back on commit)
├── aetherops.db-shm                 # lite only: WAL shared-memory index
└── .trash/                          # delete-protection recovery bin
    └── _del_<epoch>_<name>
```

In lite mode the three `aetherops.db*` files are **one unit**: backup and move them together.
Copying only the main file can lose commits made after the last checkpoint.

`connections.json`, `sessions.json`, `ai-config.json`, `ai-history/` and `audit/*.jsonl` are the
**former** storage of upstream AICmd. They are no longer written: that data now lives in the
database (MySQL, or `aetherops.db` in lite mode). The directory may still contain them if you
migrated from a single-user build.

The two `.key` files are read from the data directory only — **no** environment variable or
`config.json` key can supply them (`AETHEROPS_DATA_DIR` changes the directory, not the filenames).
When a file is missing the server generates a fresh pair, so pointing it at a database that already
holds data without those files does not fail: stored passwords and AI keys simply decrypt to empty
strings, leaving only a `Failed to decrypt secret` log line. Moving machines, moving into a container
or restoring a backup must move the whole data directory.

## Database schema and migrations

Migrations are TypeScript modules under `server/db/migrations/`, applied in version order by
`server.js` before the port binds. Applied versions are recorded in `schema_version`
(`version`, `name`, `checksum`, `execution_ms`, `applied_at`), where the checksum is sha256 over the
statement text with whitespace normalized.

| Version | Subject |
|---------|---------|
| `0001-init` | Business tables: `connections`, `sessions`, `ai_config`, `ai_history`, `ai_messages`, `audit_events`, `skills`, `snippets` |
| `0002-accounts` | `users` table, `owner_id` on every business table, composite primary keys where an ID was previously global |
| `0003-multi-ai` | `ai_config.cost_tier` / `sort_order`; new `ai_chats` (per-connection conversations with their own `chatId` + model binding) |
| `0004-cost-control` | `cost_tier_source`, `price_in` / `price_out`; new `ai_usage` (per-call tokens, plus the cost snapshot fixed at call time) and `ai_budget` |
| `0005-batch-permission` | `users.can_use_batch`, seeded from `can_use_terminal` so nobody loses access they already had |
| `0006-system-config` | New `sys_config` (key/value, owner-agnostic) — currently the hashed password for the server-host shell |
| `0007-host-metrics` | New `host_metrics_minute`: one row per owner / connection / minute with avg, peak and sample count for CPU %, memory %, disk % and load 1/5/15 |
| `0008-connection-sampling` | `connections.sampling` (`''` = follow `metrics.offlineSampling`, `skip` = never dial this connection unattended) |
| `0009-error-fingerprints` | New `error_fingerprints`: one row per owner / connection / fingerprint, with `occurrences`, `first_seen`, `last_seen` (written by the agent `after_tool` hook) |
| `0010-alerts` | New `alerts` (stateful alerts: `open` / `acked` / `resolved`, deduplicated by owner + connection + fingerprint through the generated column `open_key`) and `alert_mutes` (rule-level silence windows) |
| `0011-collaboration` | `alerts.assignee_id` / `alerts.incident_id` plus `idx_alerts_assignee` / `idx_alerts_incident`; new `incidents` (one row per owner / connection event, `open` / `resolved`, `alert_count` refreshed from the alerts table) and `alert_oncall` (account + minute-of-day shift, primary key `(owner_id, user_id, start_minute)`) |
| `0012-watch-tokens` | New `auth_watch_tokens`: one row per wallboard read-only token (`owner_id`, `label`, `token_hash`, `created_at`, `expires_at`, `revoked_at`, `last_used_at`). It is a table rather than Redis because such tokens must be listable and individually revocable, and must **not** consume the "one login session per account" slot |
| `0013-auth-sessions` | New `auth_sessions`: the login tokens used in lite mode (`token_hash` primary key, `user_id` unique index, `payload`, `issued_at`, `expires_at`). The table is created on MySQL too, so both backends share one migration chain; enterprise tokens still go to Redis |

Schema constraints worth knowing if you intend to add a migration:

- Target is MySQL 8.x with `STRICT_TRANS_TABLES` / `NO_ZERO_DATE`: time columns are
  `DATETIME(3) NOT NULL` with **no** database-side default; the app supplies UTC `Date` values.
- `lower_case_table_names=0` on the reference instance, so identifiers are case sensitive — the
  convention is snake_case everywhere.
- No `ENUM`: the default `utf8mb4_0900_ai_ci` collation is case-insensitive and would treat
  `privateKey` and `privatekey` as the same value. Columns are `VARCHAR` + `CHECK`, with the value
  set enforced by constants in code.
- `JSON` / `TEXT` columns cannot carry defaults, hence explicit `NOT NULL` or nullable.
- No foreign keys: existing delete paths are plain deletes and cascading would change their meaning.
- Every `ALTER` is wrapped in an `information_schema` existence check plus `PREPARE`, because MySQL
  has no `ADD COLUMN IF NOT EXISTS` and the migrator's contract is "a failed migration is not
  recorded, so the next start re-runs it" — which requires every statement to be re-entrant.
- `owner_id` columns have no default: a missing owner should fail loudly under strict mode rather
  than silently writing `''`, which produces rows nobody can query.

In lite mode the migration chain has a different shape (every difference is confined to the
dispatch in `server/db/migrate.ts`):

- A fresh database executes a **merged baseline** (`server/db/sqlite-schema.ts`, the final shape of
  0001–0012) instead of replaying those twelve migrations — their `information_schema` +
  `PREPARE` dynamic DDL and `FULLTEXT` have no SQLite equivalent.
- 0001–0012 are recorded as applied but not replayed; an extra `0000-baseline` row stores the
  baseline checksum, and editing the baseline after release makes startup fail (drift guard).
- From 0013 on both sides run the same chain: the translatable DDL/DML is handled by
  `server/db/dialect.ts` (`ON DUPLICATE KEY UPDATE` → `ON CONFLICT … DO UPDATE`, `GREATEST` →
  `MAX`, `VALUES(col)` → `excluded.col`, `DATE_FORMAT` registered as a custom function); anything
  it cannot translate (dynamic DDL, multi-column `ALTER`, `FULLTEXT`) gets a `sqliteSql` field in
  the migration itself.
- Concurrency protection switches from MySQL `GET_LOCK` to `BEGIN IMMEDIATE`; SQLite DDL also runs
  inside a transaction, so a failed migration really rolls back.

CLI:

```bash
pnpm migrate                 # or: node scripts/migrate.mjs
node scripts/migrate.mjs --status    # applied versions + pending count
node scripts/migrate.mjs --dump 0002 # emit a migration as plain SQL (stdout)
node scripts/migrate.mjs --force     # ignore checksum mismatch / already-applied checks
```

## What is stored where

| Data | Store | Encrypted? |
|------|-------|-----------|
| SSH connections (host, user, auth type, startup script) | `connections` (enterprise MySQL / lite SQLite, owner-scoped) | Passwords / keys / passphrases as `enc:v1:` AES-256-GCM |
| Terminal session metadata | `sessions` | no |
| AI provider profiles (base URL, model, temperature, tier, prices) | `ai_config` | API key as `enc:v1:` |
| Conversations and messages | `ai_chats`, `ai_history`, `ai_messages` | no |
| Token usage and cost | `ai_usage` | no |
| Budget caps | `ai_budget` | no |
| Audit events (commands, transfers, blocked/rewritten) | `audit_events` | no |
| Skills | `skills` (user, written from the skills editor) + files in `<app>/data/skills/*.md` (built-in) | no |
| Command snippets | `snippets` | no |
| Host metrics history (per-minute CPU / memory / disk / load) | `host_metrics_minute` (owner-scoped) | no |
| Error fingerprints (one row per owner / connection / normalized error) | `error_fingerprints` | no |
| Alerts, rule-level mutes, incidents and the on-call roster | `alerts` (with `assignee_id` / `incident_id`), `alert_mutes`, `incidents`, `alert_oncall` (owner-scoped) | no |
| Accounts (scrypt hash, role, status, 10 permission bits) | `users` | password hash only, irreversible |
| Login tokens | Enterprise: Redis (`aetherops:token:*`); lite: the `auth_sessions` table | SHA-256 hash only |
| Wallboard read-only tokens | `auth_watch_tokens` (owner-scoped, SHA-256 hash only) | n/a; the cleartext appears once, in the issue response |
| Decryption keys | data dir `*.key` files | these **are** the secrets |
| Server log, PID file, trash | data dir | no |

Practical consequences:

- The database dump alone does not expose credentials; the `.key` files do. Keep them out of any
  export that leaves your machine, and back them up separately from the database.
- Anyone with the database *and* the data directory can read every stored SSH credential. That is
  the normal threat model for a credential store; protect both accordingly.
- Live terminal sessions are in-process state. Restarting the server closes them; the persisted
  metadata lets the UI restore tabs, not the shell itself.

## Backup and move

Back up both halves together (enterprise):

```bash
mysqldump --single-transaction aetherops | gzip > aetherops-db.sql.gz
tar czf aetherops-data.tar.gz -C ~ .aetherops
```

In lite mode there are no "two halves": the database sits inside the data directory, so
`aetherops.db*` and the two `.key` files must be taken together. Copying while the server runs is
safe (WAL mode), but then include `-wal` / `-shm`; alternatively stop the server first (on exit it
runs `wal_checkpoint(TRUNCATE)` to merge the WAL back, after which a single `aetherops.db` is a
complete snapshot).

Restoring elsewhere requires the same `schema_version` rows (they come with the dump), so do not
hand-edit applied migrations. If you move the data directory, keep file modes: `config.json` should
be `0600`.

Legacy note: if `~/.aicmd` exists and `~/.aetherops` is empty, the first start moves it (falling
back to copy across devices and leaving `~/.aicmd.migrated.bak`). The `.key` files move with it, so
stored credentials remain decryptable. Setting `AETHEROPS_DATA_DIR` suppresses the move entirely.

## Storage backends: lite (SQLite) vs enterprise

Two backends, picked at deploy time:

| | lite (default) | enterprise |
|---|---|---|
| Business data | `aetherops.db` in the data directory (SQLite) | MySQL 8.x |
| Login tokens | `auth_sessions` table in the same file | Redis (`aetherops:token:*`) |
| External dependencies | **none** (zero backend services, single process) | MySQL + Redis |
| Fits | One person, one machine, offline setups, desktop / VSCode hosts | Many machines or users sharing data, central backups, an existing DBA |
| Backup | Copy the three `aetherops.db*` files + the two `.key` files | `mysqldump` + Redis RDB/AOF + the data directory |

### How to choose

You usually don't have to:

```
# nothing configured  -> falls back to lite (a SQLite file)
# any of database.host / redis.host / redis.url set -> enterprise
```

To pin it down, edit `config.json`:

```jsonc
{
  "storage": {
    "mode": "lite",          // auto | enterprise | lite
    "sqlitePath": "",        // empty = <data dir>/aetherops.db
    "busyTimeoutMs": 5000
  }
}
```

Or use environment variables only (recommended in containers):

```bash
# lite: one container, one volume, no MySQL/Redis
AETHEROPS_STORAGE_MODE=lite
AETHEROPS_DATA_DIR=/data/aetherops

# enterprise
AETHEROPS_STORAGE_MODE=enterprise
AETHEROPS_DB_HOST=mysql.internal
AETHEROPS_DB_USER=aetherops
AETHEROPS_DB_PASSWORD=***
AETHEROPS_REDIS_HOST=redis.internal
```

### Boundaries and caveats

- **Node ≥ 22.13 at runtime**: lite uses the built-in `node:sqlite`, which lost its
  `--experimental-sqlite` flag in 22.13, so every supported Node (the floor is 22.17) has it. No
  `better-sqlite3`-style native module, so no rebuild problems. The official Docker image and CI are
  on Node 24, the current LTS.
- **Modes cannot be swapped later**: each backend has its own schema and there is no built-in
  MySQL → SQLite migration tool. Switching modes means a fresh empty database (accounts,
  connections and audit history all start over).
- **Writes are serialized**: SQLite admits one writer at a time (`busyTimeoutMs` decides how long
  to wait before reporting `SQLITE_BUSY`). Fine for one person / one machine; a dozen people sharing
  one dataset should use the enterprise backend.
- **Full-text search degrades to `LIKE`**: the audit keyword search uses the ngram full-text index
  on enterprise and plain `LIKE` on lite (no index, relying on a small dataset).
- **Session tokens survive restarts**: this is a behavioral difference from the Redis version — on a
  single machine the process restarts far more often than Redis does, so lite stores `expires_at`
  in the table instead of relying on in-process state.

### Verify

```bash
pnpm build-server
node scripts/verify-storage-lite.mjs   # builds a temp DB, runs schema/migrations/repos/tokens, self-cleans
```
