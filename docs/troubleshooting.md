# Troubleshooting

**English** · [简体中文](./troubleshooting.zh.md)

Organized by the symptom you see first. Each entry states what the failure actually means, so you can
tell whether the fix belongs in your config, your proxy, or the code.

- [The server does not start](#the-server-does-not-start)
- [Login and authorization](#login-and-authorization)
- [Terminal session problems](#terminal-session-problems)
- [File transfer and zmodem](#file-transfer-and-zmodem)
- [AI features](#ai-features)
- [Server status panel](#server-status-panel)
- [Database and migrations](#database-and-migrations)
- [Build and install](#build-and-install)
- [Desktop and VS Code hosts](#desktop-and-vs-code-hosts)
- [Filing an issue](#filing-an-issue)

## The server does not start

Startup is deliberately ordered so that a broken dependency aborts **before** the port binds:
load config → validate → probe MySQL and run pending migrations → probe Redis → init services
(including the initial admin) → `listen()`. There is no "partially working" state where the UI loads
and every query errors.

| Log line | Meaning | Fix |
|----------|---------|-----|
| `[FATAL] 配置加载失败: …` | `config.json` is not valid JSON, or `AETHEROPS_CONFIG` points at a missing file | Repair the file. An explicit path that does not exist is fatal on purpose — see [configuration.md](./configuration.md#where-configuration-lives) |
| `[FATAL] 数据库配置不完整: …` then `请编辑 …（或用 AETHEROPS_DB_* 环境变量提供）` | `database.host` / `database.user` / `database.database` / `database.password` / `redis.host` (or `redis.keyPrefix`) are empty, or a port/pool value is out of range | Fill the `database` + `redis` sections, or export `AETHEROPS_DB_*` / `AETHEROPS_REDIS_*`. The whole problem list is printed at once, so fix every entry in that line, not just the first |
| `[FATAL] 依赖服务不可用（MySQL / Redis），服务不启动` | Config validated, but the probe failed (wrong host/port, access denied, unreachable, Redis auth required) | Check the printed reason just above it; test connectivity from the *same* host the app runs on |
| `[ERROR] 找不到 server 构建产物: …/dist/server/index.js` | Running `node server.js` before building | `pnpm run build-only` (dev sources are not executable by the server) |
| TLS handshake errors with `ssl: true` | Ubuntu's MySQL ships a self-signed certificate | Either set `sslCaPath` and `sslRejectUnauthorized: true`, or keep `sslRejectUnauthorized: false` (encrypted, not MITM-proof). Some combinations abort startup by design |

An **empty MySQL password counts as unconfigured** and aborts startup; `AETHEROPS_DB_PASSWORD=`
(empty) does not override it either, because blank environment values are ignored. That is a
conscious choice — a wrong credential should fail at boot with a readable message instead of
surfacing later as data-layer errors — but it means a local `root` account with no password will not
work. Create a named MySQL user with a password (any value) and use that.

A second instance on the same port fails with `EADDRINUSE`. The PID file
`~/.aetherops/aetherops.server.<port>.pid` is written after a successful bind and removed on
`SIGINT`/`SIGTERM`; a leftover file after a crash does **not** block a start.

If the terminal log shows a config key you did not set, look for `deprecated` warnings:
`auth.disabled` and `auth.accessToken` are read, dropped and reported — they belong to the removed
single-token scheme and there is no way to turn authentication off.

## Login and authorization

| Symptom | Cause | Fix |
|---------|-------|-----|
| `403 Forbidden origin` on every request, or the login page spins | The `Origin` header's host matches neither the `Host` header nor localhost | Reverse proxy must forward the original host: `proxy_set_header Host $host;`. Same applies to the WebSocket handshake |
| `401 Unauthorized` right after a successful login | Token expired (7200 s sliding), or you logged in elsewhere — **single active session per account** | Re-login. If a second browser/tab must work, that is a design constraint, not a bug |
| Front-end says the session was replaced | The same account obtained a new token (another device, or an admin reset) | Expected behavior; `session_replaced` is distinguished from plain expiry on purpose |
| Logged in, but every panel says no permission | Self-registration lands as `status=pending` with **all 10 bits off** | An admin grants bits in **account menu → user management** |
| "cannot demote / disable / delete" (HTTP 409) | The last usable admin is protected, and self-edit cannot change own `role`/`status` | Use a second admin account. This guard exists to prevent an unrecoverable lockout |
| Password rejected although it is correct | Account was created by an admin with a generated password shown once | Admin resets it (a new one is generated) |
| Cannot log in at all after a data-dir restore | `users` lives in MySQL, the tokens in Redis — restoring only one half is not a restore | Restore both; there is no offline password-reset command, so keep an admin account you can reach |

Login failures are deliberately indistinguishable ("unknown user" and "wrong password" take similar
time and return the same message), so there is nothing to diagnose from the client side. Server-side
there is no per-account lockout — rate limiting is your reverse proxy's job.

## Terminal session problems

**Connected but stuck at "Connecting…"** — the WebSocket opened, then the session never got created.
Check, in order: the proxy passes `Upgrade`/`Connection` headers (see
[deployment.md](./deployment.md#reverse-proxy-and-tls)); the account has the `terminal` permission (the
handshake closes with `1008` before that, so no session is possible without it); the token in
`?token=` is still valid.

**Socket closes immediately with `1008`** — origin rejected, token invalid, or `terminal` permission
missing. The close reason is `Forbidden origin` vs `Unauthorized` vs `Forbidden`, so the reason string
tells you which of the three fired.

**Output lags or characters are missing under heavy output** — high-frequency frames are dropped when
the socket's send buffer exceeds 4 MB (`[WS] Backpressure: dropping message` in the log). This is a
deliberate degradation: dropping a screenful beats blocking the shell. Scrollback for the *remote*
shell is unaffected; only what your browser missed is. `cat` of a huge binary is the usual trigger.

**A command runs against the wrong host** — almost always a session-id mix-up in the UI, not the
backend. Every message carrying a `sessionId` is owner-checked server-side; if you can see another
account's session id you should get a rejection, and that is a bug worth reporting.

**SSH auth fails with no useful message** — enable `debug.sshDebug` (or `AETHEROPS_SSH_DEBUG=1`) and
the ssh2 protocol trace is forwarded into the front-end terminal. Also confirm the stored credential:
private keys are decrypted with `~/.aetherops/connections.key`, so a data directory restored without
that file yields auth failures that look like "wrong password".

**Jump-host session lands on the jump host and stays there** — the startup script is written to the
shell ~800 ms after the channel opens. If the MOTD is long or the link is slow, add a `sleep 1` line
(see [jump-host.md](./jump-host.md)).

## File transfer and zmodem

- **Upload rejected with 413 / "File too large"** — `auth.maxUploadMb` (default 100) caps HTTP uploads
  and sizes the WebSocket `maxPayload` (limit × 1.4, because base64 inflates ~33 %). Raise the value in
  config or via `AETHEROPS_MAX_UPLOAD_MB`, and check whether your proxy has its own `client_max_body_size`.
- **`rz` / `sz` hang, corrupt files, or work intermittently** — the shipped
  `patches/zmodem.js.patch` is what makes the zmodem flow reliable. If the patch is not applied
  (`patchedDependencies` missing from the lock file), the build fails at the pin check; a hand-assembled
  `node_modules` without the patch silently degrades instead. Verify with `pnpm run check-pin`.
- **Files land in the wrong directory** — the web UI queries the current working directory before
  uploading. While a remote `rz` is waiting, that probe is skipped (injecting text would interrupt it),
  so the target directory can be stale. Re-run the transfer after `rz` finishes, or use the file manager.
- **Download produces a 0-byte file** — check the SFTP subsystem is enabled on the target sshd; the
  terminal channel working does not imply SFTP works.

## AI features

| Symptom | Explanation |
|---------|-------------|
| Model list empty / chat refuses to start | No provider profile for this account. AI settings are per-account; a second account starts with nothing |
| `chat-token-limit` / `daily-token-limit` / `daily-cost-limit` | A budget cap was hit; the error carries the numbers (e.g. `(182340/200000)`). `0` means unlimited — set the field to `0` if you only wanted to "reset" it |
| Costs show as *unknown* | The pricing catalog was unreachable when the profile was saved. Cost is never guessed: an unknown price displays as unknown instead of `$0` |
| Daily cost looks too low and the panel marks it partial | Some calls had no known price; treat today's total as a floor |
| `auto` always picks the same model | All your profiles sit at the default tier 3 (no prices, no name-rule match), so they are equally distant from every target tier. Set `cost_tier` manually or let the catalog price them |
| AI request blocked by the proxy | Two optional outbound calls exist: your AI provider, and the OpenRouter catalog (`https://openrouter.ai/api/v1/models`, no key). The second one is best-effort with an 8 s timeout and degrades silently — blocking it is supported |
| Streaming stops mid-answer | Provider-side timeout or a reverse-proxy buffer setting. Disable response buffering for the API path (`proxy_buffering off;`) so SSE/WS frames are not held |

## Server status panel

The panel probes the **remote** host and adapts to its OS family
(`windows` / `macos` / `linux` / `harmony` / `unix` / `unknown`). What you see is bounded by what the
platform exposes:

- Metrics that cannot be collected are marked *unsupported* and rendered as "无法采集 / not
  collectable" with **no chart**, rather than a flat line at zero. A missing graph is a statement
  about the platform, not a bug.
- A jump-host session's panel describes the **jump host**, because that is where the probe runs. The
  AI may still target the final host via the startup script; the status panel does not follow the hop.
- HarmonyOS detection is pattern-based (`/etc/os-release`, `OHOS_*`, `hongmeng` markers) and falls back
  to Linux when the fingerprint is ambiguous. If a HarmonyOS host reports as Linux, that is a
  detection gap worth a report with the `uname -a` and `/etc/os-release` output.

## Database and migrations

- **Migration did not apply and the server exited** — migrations run before `listen()`; the log names
  the version and the SQL error. A failed migration is **not** recorded, so the next start re-runs it.
  That is why every `ALTER` in `server/db/migrations/` is wrapped in an `information_schema` check.
- **`checksum` mismatch** — you edited an already-applied migration. Do not use `--force` to silence
  it; revert the file or write a new migration. Hand-editing applied migrations makes production
  schema unreproducible.
- **Want to inspect before applying** — `node scripts/migrate.mjs --status` (applied versions + pending
  count), `--dump 0002` (emit a migration as plain SQL).
- **Duplicate entry / data-type errors under strict mode** — the schema targets
  `STRICT_TRANS_TABLES`/`NO_ZERO_DATE` and `DATETIME(3) NOT NULL` columns with no database-side
  default; timestamps are supplied by the app as UTC `Date`. An external tool writing rows with
  `NOW()` on a server whose `system_time_zone` is not UTC will shift values (the reference instance ran
  `CST`, hence the `+00:00` driver timezone).
- **Rows nobody can read** — `owner_id` has no default on purpose; if you add a table, keep that rule so
  a missing owner fails loudly instead of silently writing `''`.

## Build and install

| Error | Cause | Fix |
|-------|-------|-----|
| `[pin] … 声明成了范围「^1.0.0」` / `声明 1.0.80，实际装的是 …` | The pin check refuses version ranges or a `node_modules` that disagrees with `package.json` | `pnpm install --frozen-lockfile`; upgrade deliberately via `pnpm run upgrade-pin -- <pkg>@<ver>` and commit `package.json` + lock together |
| `[pin] pnpm-lock.yaml 是 pnpm 11/12 写的 …` | A newer pnpm rewrote the lock in a shape CI's pnpm 10 rejects under `--frozen-lockfile` (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`) | Regenerate with the CI major: `npx pnpm@10 install --lockfile-only` |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` in CI | Same root cause as above, seen later | Same fix; there is deliberately no `packageManager` field forcing a rewrite of your local `node_modules` |
| Native module build failure (`node-pty`, `ssh2`, `cpu-features`) | Missing C++ toolchain | Linux `python3 make g++`; macOS Xcode CLT; Windows VS Build Tools (C++ workload) |
| Post-install scripts skipped, terminal is broken | pnpm only runs a dependency's build script if it is allow-listed | The list lives in `pnpm-workspace.yaml` — `onlyBuiltDependencies` (pnpm 10/11) and `allowBuilds` (pnpm 12+), both present on purpose — with a shorter mirror in `package.json#pnpm`. `pnpm approve-builds` adds entries interactively. If `node-pty`/`ssh2`/`cpu-features` were skipped, remove `node_modules` and reinstall with the allow-list in place |
| `EBADENGINE` warnings, or agent-core throws syntax errors at runtime | Node is older than the pinned engine requirement (`>= 22.17.0`) | Use Node 22 LTS or newer; Docker and CI both run 22 |
| Install fails resolving `@cicctencent/agent-core` | It is pinned and fetched from the public npm registry — a mirror or firewall that filters packages breaks it | Allow `registry.npmjs.org` (or npmmirror equivalent) for that scope |
| Build hangs after "build complete" | `vite build` occasionally keeps the process alive on watchers in some environments | Ctrl-C is safe once `dist/` is written; the server build (`tsc -p tsconfig.server.json`) is the step that must have finished |

## Desktop and VS Code hosts

- **macOS: "app is damaged" / Gatekeeper blocks it** — CI builds are ad-hoc signed (no Developer ID
  certificate), so quarantine must be cleared: `xattr -cr /Applications/AetherOps.app`.
- **Auto-update finds a release but does not install it** — the desktop client only *prompts*; it does
  not download and replace binaries silently.
- **Fork never receives updates / updates from the wrong project** — `electron/updater.js` queries a
  hard-coded GitHub releases endpoint for `SubDong/AetherOps`. Change it if you publish your own build.
- **VS Code host: "server did not become ready" but the port answers** — `/health` requires the launch
  token when the host injects `AETHEROPS_LAUNCH_TOKEN`, so an unrelated process squatting on the port
  cannot pass as ours. Free the port (default 9802) or pick another.
- **VS Code host works locally, breaks for another user** — the extension launches the backend with the
  Node binary it resolved (`AETHEROPS_NODE`). If that is older than the engine requirement, the server
  dies at import; check the extension's output channel.
- **Terminal panes are blank in VS Code** — the webview pages (`vscode-term`, `vscode-edit`) are built
  assets shipped inside the VSIX. A VSIX packaged without `node scripts/prepare-vscode-runtime.mjs`
  is missing its backend runtime; use `pnpm run vscode:package`.
- **VS Code sidebar shows "服务未启动" with `HTTP 401` while the backend is fine** — the extension host's
  own `getConnections()` / `deleteConnection()` calls carry no bearer token (documented gap, see
  [packages/vscode/README.md](../packages/vscode/README.md)). Sign in inside the WebView and manage
  connections there; the tree is not a reliable health signal today.
- **VS Code: "server did not become ready" and the port never opens** — the extension starts the same
  production backend, which exits on `[FATAL] 数据库配置不完整` if `~/.aetherops/config.json` has an
  empty `database`/`redis` section. The child process inherits VS Code's own environment (minus
  `NODE_OPTIONS`, which the host injects and which breaks a clean Node start), so `AETHEROPS_DB_*`
  variables are only seen if the VS Code process itself had them — launching from a desktop icon
  usually does not. Put the settings in the config file, or launch VS Code from a shell that exports
  them. The real reason is in the Output panel → `[aetherops-server]` lines.

## Filing an issue

Include, in this order — it usually answers the question before anyone replies:

1. Host (web / Electron / VS Code), version (`package.json` version or the release tag), OS of the
   machine running AetherOps, and the **target** OS if the issue is about a remote host.
2. Node, pnpm and MySQL/Redis versions; whether TLS is enabled on MySQL.
3. The relevant log tail from `~/.aetherops/server.log` (the same text you see on the console), and the
   browser/DevTools console for front-end problems.
4. Exact `[FATAL]` / `[pin]` / `[WS]` / migration lines — they are written to fail loudly, so quoting
   them is faster than describing the symptom.
5. Reproduction steps with the permission bits of the account you used, since most "why is this
   forbidden" reports are pending-account or bit-revocation cases.

**Redact before posting.** `server.log` can contain hostnames, usernames, connection names, command
text and terminal output. Remove secrets and internal addresses; do not attach a log you have not read.
For security issues, use [SECURITY.md](../SECURITY.md) instead of a public issue.
