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

### `database`

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

### `debug`

| Key | Default | Meaning |
|-----|---------|---------|
| `sshDebug` | `false` | Forward ssh2 protocol-level debug output into the front-end terminal |

## Environment variables

| Variable | Maps to | Notes |
|----------|---------|-------|
| `PORT` | `server.port` | Server reads only `PORT` here |
| `HOST` / `AETHEROPS_HOST` | `server.host` | `HOST` takes precedence |
| `AETHEROPS_DATA_DIR` | data directory | Disables the legacy `~/.aicmd` auto-migration |
| `AETHEROPS_CONFIG` | config file path | Missing file = fatal |
| `AETHEROPS_DB_HOST` / `AETHEROPS_DB_PORT` / `AETHEROPS_DB_USER` / `AETHEROPS_DB_PASSWORD` / `AETHEROPS_DB_NAME` | `database.*` | Avoid putting secrets on disk |
| `AETHEROPS_DB_POOL_SIZE` / `AETHEROPS_DB_SSL` / `AETHEROPS_DB_TZ` | `database.connectionLimit` / `.ssl` / `.timezone` | |
| `AETHEROPS_DB_SSL_CA` | `database.sslCaPath` | |
| `AETHEROPS_DB_SSL_INSECURE` | `database.sslRejectUnauthorized` (inverted) | Named "INSECURE" so the meaning survives a copy-paste |
| `AETHEROPS_REDIS_URL` / `_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB` / `_PREFIX` / `_CONNECT_TIMEOUT_MS` | `redis.*` | |
| `AETHEROPS_MAX_UPLOAD_MB` | `auth.maxUploadMb` | |
| `AETHEROPS_LAUNCH_TOKEN` | `auth.launchToken` | Set by desktop/VSCode hosts |
| `AETHEROPS_SSH_DEBUG` | `debug.sshDebug` | `1` or `true` |
| `AETHEROPS_NODE` | — | Node binary used to launch the backend (VSCode host) |
| `AETHEROPS_BUNDLED` | — | Set at build time by `scripts/prepare-vscode-runtime.mjs`; do not set by hand |
| `AETHEROPS_VSCODE_PRUNE_PREBUILDS` | — | `1` trims node-pty prebuilds to the current platform |
| `VITE_PORT` | — | Dev-server port only (default 9801) |

AI provider settings (base URL, key, model) are **not** configurable through env: they are
per-account data stored in MySQL, edited in the UI. There is no `OPENAI_API_KEY` lookup.

## Storage layout

```
~/.aetherops/                       # or $AETHEROPS_DATA_DIR
├── config.json          0600       # the only config file; template auto-created
├── connections.key                  # AES-256-GCM key for SSH passwords / private keys / passphrases
├── ai-config.key                    # AES-256-GCM key for AI provider API keys
├── server.log                       # backend log (console output is tee'd here)
├── aetherops.server.<port>.pid      # written on listen, removed on SIGINT/SIGTERM
└── .trash/                          # delete-protection recovery bin
    └── _del_<epoch>_<name>
```

`connections.json`, `sessions.json`, `ai-config.json`, `ai-history/` and `audit/*.jsonl` are the
**former** storage of upstream AICmd. They are no longer written: that data now lives in MySQL.
The directory may still contain them if you migrated from a single-user build.

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
| SSH connections (host, user, auth type, startup script) | MySQL `connections` (owner-scoped) | Passwords / keys / passphrases as `enc:v1:` AES-256-GCM |
| Terminal session metadata | MySQL `sessions` | no |
| AI provider profiles (base URL, model, temperature, tier, prices) | MySQL `ai_config` | API key as `enc:v1:` |
| Conversations and messages | MySQL `ai_chats`, `ai_history`, `ai_messages` | no |
| Token usage and cost | MySQL `ai_usage` | no |
| Budget caps | MySQL `ai_budget` | no |
| Audit events (commands, transfers, blocked/rewritten) | MySQL `audit_events` | no |
| Skills | MySQL `skills` (user) + files in `<app>/data/skills/*.md` (built-in) | no |
| Command snippets | MySQL `snippets` | no |
| Accounts (scrypt hash, role, status, 10 permission bits) | MySQL `users` | password hash only, irreversible |
| Login tokens | Redis (`aetherops:token:*`, hashed, sliding TTL) | n/a |
| Decryption keys | data dir `*.key` files | these **are** the secrets |
| Server log, PID file, trash | data dir | no |

Practical consequences:

- The database dump alone does not expose credentials; the `.key` files do. Keep them out of any
  export that leaves your machine, and back them up separately from the database.
- Anyone with MySQL *and* the data directory can read every stored SSH credential. That is the
  normal threat model for a credential store; protect both accordingly.
- Live terminal sessions are in-process state. Restarting the server closes them; the persisted
  metadata lets the UI restore tabs, not the shell itself.

## Backup and move

Back up both halves together:

```bash
mysqldump --single-transaction aetherops | gzip > aetherops-db.sql.gz
tar czf aetherops-data.tar.gz -C ~ .aetherops
```

Restoring elsewhere requires the same `schema_version` rows (they come with the dump), so do not
hand-edit applied migrations. If you move the data directory, keep file modes: `config.json` should
be `0600`.

Legacy note: if `~/.aicmd` exists and `~/.aetherops` is empty, the first start moves it (falling
back to copy across devices and leaving `~/.aicmd.migrated.bak`). The `.key` files move with it, so
stored credentials remain decryptable. Setting `AETHEROPS_DATA_DIR` suppresses the move entirely.
