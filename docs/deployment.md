# Deployment

**English** · [简体中文](./deployment.zh.md)

AetherOps is one Node process plus **two hard dependencies: MySQL 8.x and Redis**. There is no
"standalone" mode — the process refuses to bind its port if either dependency is unreachable, so
planning capacity for those two services is part of deployment, not an afterthought.

- [Channels at a glance](#channels-at-a-glance)
- [Requirements](#requirements)
- [Provisioning MySQL and Redis](#provisioning-mysql-and-redis)
- [Source build](#source-build)
- [Docker](#docker)
- [Reverse proxy and TLS](#reverse-proxy-and-tls)
- [Running as a service](#running-as-a-service)
- [Upgrades and rollback](#upgrades-and-rollback)
- [Desktop and VS Code packaging](#desktop-and-vs-code-packaging)
- [CI/CD release flow](#cicd-release-flow)
- [Notes for forks](#notes-for-forks)
- [Operational security](#operational-security)

## Channels at a glance

| Channel | Use when | Notes |
|---------|----------|-------|
| Source build | Development, custom builds, air-gapped rollout you script yourself | `pnpm install --frozen-lockfile` + `pnpm build-only` |
| Docker | Server deployment, team-shared instance | Image contains the app only; you supply MySQL and Redis |
| Docker Compose (app + db + cache) | Single-host trial or small team | Recommended starting point below |
| Electron desktop | Individual users who want a native window | Ships its own backend; still needs MySQL and Redis reachable from that machine |
| VS Code extension | Terminal inside VS Code | Extension bundles the backend runtime; same dependency rule |
| npm global | **Not published** | Root `package.json` is `"private": true`. Install from source or a release artifact |

The desktop and VS Code channels are convenient, but they do not remove the server dependency: each
user still needs a MySQL schema and a Redis instance. For a team, run one web instance and let people
point their desktop/VS Code hosts at it or at a shared database.

## Requirements

| Component | Version | Why this exact floor |
|-----------|---------|----------------------|
| Node.js | **>= 22.17.0** | Required by `@cicctencent/agent-core` (the agent engine). Docker and CI both use Node 22 |
| pnpm | **10** | CI, the Docker image and the pin check all use 10. `pnpm-workspace.yaml` holds the native-module build allow-list (`onlyBuiltDependencies` for 10/11, `allowBuilds` for 12+) plus the zmodem patch; `package.json#pnpm` mirrors the essentials for older pnpm. A lock rewritten by pnpm 11/12 makes CI's `--frozen-lockfile` fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` |
| MySQL | 8.x | Migrations assume `utf8mb4_0900_ai_ci`, `STRICT_TRANS_TABLES`, `DATETIME(3)` |
| Redis | 6+ (any recent) | Login token store; `keyPrefix` lets you share an instance |
| C++ toolchain | for native modules | `node-pty`, `ssh2`, `cpu-features` need build scripts: Linux `python3 make g++`, macOS Xcode CLT, Windows VS Build Tools |

The build chain is pinned on purpose: `pnpm run check-pin` (run automatically by `build-only`) fails
the build if `@cicctencent/agent-core` or `vite` is declared as a range or does not match what is
installed. See [CONTRIBUTING.md](../CONTRIBUTING.md#dependency-pinning).

## Provisioning MySQL and Redis

Create a database and an application user. The app runs its own migrations at startup, so the user
needs DDL on that schema; if you prefer to apply SQL yourself (`node scripts/migrate.mjs --dump 0001`
and friends), a DML-only account is enough.

```sql
CREATE DATABASE aetherops CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'aetherops'@'%' IDENTIFIED BY 'change-me';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON aetherops.* TO 'aetherops'@'%';
FLUSH PRIVILEGES;
```

Redis: set `requirepass` if the instance is reachable beyond localhost, and pick a logical `db` plus a
`keyPrefix` if it is shared with other apps (`aetherops:` is the default prefix). Redis persistence is
a latency question, not a correctness one — tokens are short-lived, so losing them means users log in
again.

Things that have bitten people:

- **Pool size**: `database.connectionLimit` defaults to `5`, not 10, because a shared instance with
  `max_connections=50` cannot afford 10 connections per host app. If you scale out, do the arithmetic.
- **Timezone**: the app writes UTC `Date` values and never uses `NOW()`, because the reference instance
  had `system_time_zone=CST` and everything shifted by 8 hours. Leave `database.timezone` at `+00:00`
  unless you understand what changes.
- **TLS**: Ubuntu's MySQL ships a self-signed certificate with no CA, so strict verification fails by
  default; `sslRejectUnauthorized: false` gives you encryption that is not MITM-proof. Some TLS key
  combinations abort startup rather than being silently ignored.

All keys and environment variables are listed in [configuration.md](./configuration.md).

## Source build

```bash
git clone https://github.com/SubDong/AetherOps.git
cd AetherOps

pnpm install --frozen-lockfile
pnpm run build-only          # pin check → vite build → tsc -p tsconfig.server.json

# Point the app at your MySQL/Redis (config file or environment)
export AETHEROPS_DB_HOST=127.0.0.1
export AETHEROPS_DB_USER=aetherops
export AETHEROPS_DB_PASSWORD='change-me'
export AETHEROPS_REDIS_HOST=127.0.0.1

node server.js                       # defaults to 127.0.0.1:9802
node server.js --port 3000
```

`server.js` boots the backend from `dist/` — running it before `build-only` exits with
`[ERROR] 找不到 server 构建产物`. On first successful start it creates `~/.aetherops/config.json`
(mode `0600`), applies migrations, and prints the initial administrator once:

```
[Auth] 已创建初始管理员  admin / <random 16-char password>
```

Capture that line; it is not repeated, and there is no offline password-reset command. Sign in, create
a real admin account, and either keep `admin` as a break-glass credential you disable or delete it.

Verify an instance is behaving:

```bash
node scripts/migrate.mjs --status   # applied versions + pending count
node scripts/verify-auth.mjs        # login, pending, permissions, isolation, single session, delete-account
```

`pnpm run smoke` (`scripts/smoke-terminal.mjs`) drives the terminal pipeline but does not send a bearer
token yet, so against an instance with the account system enabled it stops at its first API call with
401. Use `verify-auth.mjs` for end-to-end verification; teaching the smoke script to log in first is a
useful contribution — see [CONTRIBUTING.md](../CONTRIBUTING.md#test-scripts).

## Docker

The image is a two-stage build (`node:22-slim` for build and runtime, pnpm 10 in both) and contains
only the application. MySQL and Redis are **not** inside it.

### One command

```bash
pnpm docker:build           # → aetherops:<package.json version> + aetherops:latest
```

[`scripts/docker-build.mjs`](../scripts/docker-build.mjs) wraps `docker build` so that failure modes
knowable in advance are reported before the build starts instead of five layers into:

- the files the Dockerfile `COPY`s (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `patches`)
  must be present;
- the daemon must answer `docker version`, and the message is the raw daemon error rather than a stack;
- `.dockerignore` must actually cover the heavy local artifacts on disk (`node_modules`, `dist*`,
  `release`, `packages/vscode/runtime`, `*.vsix`) — `COPY . .` otherwise ships them into the context,
  and a stale native `node_modules` sitting next to a `--frozen-lockfile` install makes the resulting
  image unattributable;
- every produced tag gets OCI labels (`image.title`, `image.version`, `image.revision`,
  `image.created`) so a running container can be traced back to the commit it was built from; a dirty
  working tree is warned about, because then no commit matches the bytes.

Flags you do not name are forwarded to `docker build` verbatim:

```bash
pnpm docker:build -- --tag registry.example.com/team/aetherops --version 1.0.27 --push
pnpm docker:build -- --platform linux/amd64       # cross-build: switches to buildx + --load
pnpm docker:build -- --no-cache --pull --dry-run  # --dry-run prints the command and exits
```

`--dry-run` deliberately does not require a running daemon, so you can see what would run on a machine
where Docker Desktop is closed.

Plain `docker build` still works — it is what the wrapper execs:

```bash
docker build -t aetherops .

docker run -d \
  --name aetherops \
  -p 127.0.0.1:9802:9802 \
  -e AETHEROPS_DB_HOST=172.17.0.1 \
  -e AETHEROPS_DB_USER=aetherops \
  -e AETHEROPS_DB_PASSWORD='change-me' \
  -e AETHEROPS_REDIS_HOST=172.17.0.1 \
  -v aetherops-data:/root/.aetherops \
  aetherops
```

Image facts worth knowing:

- `HOST=0.0.0.0` is baked in (a container must accept external connections), while a plain source run
  binds `127.0.0.1`. Publish the port to localhost unless you have TLS and access control in front.
- `VOLUME /root/.aetherops` is declared, so forgetting `-v` puts data in a named anonymous volume
  instead of the container's writable layer — safer than losing it, still awkward to back up. Bind an
  explicit volume or path in production. If you set `AETHEROPS_DATA_DIR`, mount *that* path instead.
- `data/skills` is copied to `/app/data/skills` because built-in skills are read from
  `process.cwd()/data/skills` — not from the data directory. Omitting that step yields an image whose
  skill list is empty.
- `TZ=Asia/Shanghai` is only the container's clock label; timestamps in the database are written UTC.
- Build-time mirrors (aliyun Debian, npmmirror for pnpm and Electron) are configured in the Dockerfile.
  If you build in another region, adjust those lines; they change nothing at runtime.

### Docker Compose with MySQL and Redis

This is the shortest path to a working instance on one host. It is *not* a high-availability setup —
see [Notes for forks](#notes-for-forks) on the single-instance constraint.

```yaml
services:
  aetherops:
    build: .
    ports:
      - "127.0.0.1:9802:9802"
    environment:
      AETHEROPS_DB_HOST: mysql
      AETHEROPS_DB_PORT: "3306"
      AETHEROPS_DB_USER: aetherops
      AETHEROPS_DB_PASSWORD: change-me
      AETHEROPS_DB_NAME: aetherops
      AETHEROPS_REDIS_HOST: redis
      AETHEROPS_REDIS_PORT: "6379"
      AETHEROPS_REDIS_PASSWORD: change-me-redis
    volumes:
      - aetherops-data:/root/.aetherops
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  mysql:
    image: mysql:8.4
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
    environment:
      MYSQL_ROOT_PASSWORD: change-me-root
      MYSQL_DATABASE: aetherops
      MYSQL_USER: aetherops
      MYSQL_PASSWORD: change-me
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-pchange-me-root"]
      interval: 10s
      timeout: 5s
      retries: 12
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass change-me-redis
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "change-me-redis", "ping"]
      interval: 10s
      timeout: 5s
      retries: 12
    restart: unless-stopped

volumes:
  aetherops-data:
  mysql-data:
  redis-data:
```

```bash
docker compose up -d
docker compose logs -f aetherops     # watch for the [Auth] initial admin line
```

If MySQL rejects the connection because the account lacks DDL, apply the migrations yourself first
(`node scripts/migrate.mjs` from a source checkout pointed at the same database), then restart the app.

## Reverse proxy and TLS

Two things break without the right proxy config: WebSocket (`/ws/terminal` carries every terminal
byte), and the origin allow-list — the server accepts a request only when the `Origin` host equals the
`Host` header (or is localhost), so stripping the host produces `403 Forbidden origin` everywhere.

```nginx
server {
    listen 443 ssl http2;
    server_name aetherops.example.com;

    ssl_certificate     /etc/letsencrypt/live/aetherops.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aetherops.example.com/privkey.pem;

    client_max_body_size 120m;   # must be >= auth.maxUploadMb (default 100)

    location / {
        proxy_pass http://127.0.0.1:9802;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;           # required by the origin check
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                   # streaming AI replies
        proxy_read_timeout 3600s;              # idle terminals must not be cut
    }
}
```

`X-Forwarded-For` is recorded for audit context only; the application does not parse it to make trust
decisions, so do not rely on it as an access-control input.

## Running as a service

There are three ways to keep the process up; pick one, do not mix them on the same port.

**The bundled CLI** (`bin/aetherops.js`, exposed as `aetherops` through the `bin` field) detaches its
own child and tracks it by a per-port PID file:

```bash
aetherops start [-p 9802]     # requires dist/ — build first
aetherops stop | restart | -v
```

It appends console output to `~/.aetherops/server.log`, opens a browser, and — important for a server
— if the port is busy it **increments until it finds a free one** instead of failing. Behind a reverse
proxy that expects 9802, that turns a port conflict into a silently wrong upstream, so check the
printed URL. `stop` falls back to a port-ownership lookup (`netstat` on Windows, `lsof` elsewhere)
when the PID file is missing, so it can be pointed at a process it did not start.

**pm2** is what the `pnpm start` / `stop` / `restart` scripts wrap (`aetherops-server`), the quickest
option if you already run Node services that way:

```bash
pnpm start -- --port 9802
pm2 logs aetherops-server
```

**systemd** needs nothing special, since the app is a plain foreground Node process:

```ini
[Unit]
Description=AetherOps
After=network-online.target mysql.service redis.service

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=AETHEROPS_DB_HOST=127.0.0.1
Environment=AETHEROPS_DB_USER=aetherops
Environment=AETHEROPS_DB_PASSWORD=change-me   # env or config.json, never a command-line flag
Environment=AETHEROPS_REDIS_HOST=127.0.0.1
Environment=HOST=127.0.0.1
Environment=PORT=9802
WorkingDirectory=/opt/aetherops
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=aetherops

[Install]
WantedBy=multi-user.target
```

The process writes its PID to `~/.aetherops/aetherops.server.<port>.pid` on bind and removes it on
`SIGINT`/`SIGTERM`, so a supervisor's stop signal is enough — there is no separate shutdown command.
Console output is also appended to `~/.aetherops/server.log`.

**One instance at a time.** Live terminal sessions are in-process state; a load-balanced pair would
route a browser's HTTP calls to one host and its WebSocket to another, and "one active session per
account" would thrash between two token writers. Vertical scale is the supported answer today.

## Upgrades and rollback

```bash
# 1. Back up both halves — the database *and* the key files
mysqldump --single-transaction aetherops | gzip > aetherops-db.sql.gz
tar czf aetherops-data.tar.gz -C ~ .aetherops

# 2. Update the code or image
git fetch --tags && git checkout v<new>      # or: docker pull / rebuild
pnpm install --frozen-lockfile && pnpm run build-only

# 3. Restart: migrations run automatically before the port binds
pm2 restart aetherops-server
```

Rules that follow from how migrations are recorded in `schema_version`:

- Pending migrations apply themselves at start; a failed migration is **not** recorded and is retried
  on the next start, which is why every statement must be re-entrant.
- **Migrations are forward-only.** Downgrading the app does not un-apply schema. Rolling back an
  upgrade means restoring the database dump from step 1 — which also loses data written since.
- Never edit an applied migration; the checksum check exists to catch exactly that. `--force` is for
  recovering a deliberately rewritten history, not for making an error go away.
- Losing `~/.aetherops/*.key` makes every stored SSH password, private key and AI API key
  undecryptable. A database dump alone cannot be restored into a working instance without them.

## Desktop and VS Code packaging

```bash
pnpm electron:build:win      # NSIS .exe
pnpm electron:build:mac      # DMG (x64 + arm64)
pnpm electron:build:linux    # AppImage / deb / rpm / snap
pnpm run vscode:package      # build-only → prepare-vscode-runtime → vsce package
```

Artifacts land in `release/` (desktop) and `packages/vscode/` (VSIX). Notes:

- macOS builds in CI are **ad-hoc signed** (no Developer ID certificate), so downloaded apps need
  `xattr -cr /Applications/AetherOps.app` to get past Gatekeeper.
- The VSIX bundles the backend runtime (including `node_modules`), which is why
  `scripts/prepare-vscode-runtime.mjs` is a required step; `AETHEROPS_VSCODE_PRUNE_PREBUILDS=1` trims
  node-pty prebuilds to the current platform to keep the archive smaller.
- `scripts/electron-build.js` sets npmmirror endpoints for Electron and electron-builder binaries.
  Override `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` if you build elsewhere.

## CI/CD release flow

Two GitHub workflows, separated by tag prefix so they never collide:

| Workflow | Trigger | Produces |
|----------|---------|----------|
| `.github/workflows/build-vsix.yml` | tag `aetherops-v*` | VSIX + win/mac/linux desktop artifacts on one GitHub Release; then publishes to the VS Code Marketplace (`VSCODE_TOKEN`) and Open VSX (`OVSX_TOKEN`). Runs on `master` pushes and PRs too, as build-only jobs |
| `.github/workflows/build.yml` | tag `v*`, or manual dispatch with a platform choice | Desktop artifacts only (fallback channel) |

There is a third, non-GitHub pipeline: [`.cnb.yml`](../.cnb.yml) runs on the CNB build platform
(<https://cnb.cool>). It verifies the build on `master` pushes and, on a tag push, builds the **Linux**
Electron artifacts only and publishes them into a *CNB* release (not a GitHub Release), with a download
note pointing back at GitHub. Same pin rules as the workflows: `npm i -g pnpm@10`,
`pnpm install --frozen-lockfile`, and the same npmmirror endpoints.

Details:

- Every job installs with `pnpm install --frozen-lockfile` on pnpm 10 / Node 22 (the VSIX jobs use
  Node 20 for tooling steps, since they do not run the server).
- `build-vsix.yml` refuses to release when the tag does not match `packages/vscode/package.json`
  version — bump the extension version before tagging.
- A tag containing `-` (e.g. `aetherops-v0.1.26-beta1`) is marked `prerelease`.
- Release jobs need `contents: write`, which the workflows already declare; publishing needs the two
  marketplace tokens as repository secrets.

**Current state of this repository:** no tags have been pushed yet, so **Releases is empty** — the
pipelines above describe what happens when you tag, not artifacts you can download today. Until the
first release exists, install from source or build the image.

```bash
git tag aetherops-v0.1.26
git push origin aetherops-v0.1.26
```

## Notes for forks

If you publish your own build, these are the hard-coded points to change — each has caused "works
upstream, wrong for the fork" reports:

1. `electron/updater.js` — `GITHUB_API` targets `repos/SubDong/AetherOps/releases/latest`. It only
   *notifies* about a newer release (no silent download-and-replace), but a fork will keep telling its
   users about upstream releases.
2. `packages/vscode/package.json` — `publisher: "subdong"` and `name: "aetherops"` decide where
   `vsce publish` uploads to. Publishing under someone else's publisher ID fails at the marketplace
   step, not at build time.
3. Root `package.json` — `"name": "@subdong/aetherops"`, `"private": true`. Do not flip `private`
   unless you actually intend to publish to npm and have reviewed `files`.
4. `Dockerfile`, `.github/workflows/*` and `.cnb.yml` mirror regions — Debian/aliyun and npmmirror
   endpoints are tuned for builds in China. If you do not use CNB, delete `.cnb.yml`; leaving it in
   means a tag push silently produces a second, divergent release on another platform.
5. Keep the license: [LICENSE](../LICENSE) is MIT with the upstream attribution for AICmd;
   `packages/vscode/LICENSE` carries the upstream notice. Retain both.
6. Rename audit: identifiers were renamed from the upstream project (`AICMD_*` → `AETHEROPS_*`,
   `~/.aicmd` → `~/.aetherops`, `__AETHEROPS_SYS__`). If you rename again, keep
   `AETHEROPS_DATA_DIR`/`AETHEROPS_CONFIG` handling and the legacy migration consistent on both sides.

## Operational security

Read this section even if you skip the rest.

- **AetherOps gives the AI a real shell.** A prompt can run commands on every host the account can
  reach. Treat the web port as an SSH endpoint, not as a dashboard: keep it on the LAN or behind VPN,
  restrict it at the firewall, and put TLS in front of it.
- **The default bind is `127.0.0.1`** for source runs; only the container image sets `HOST=0.0.0.0`.
  Binding `0.0.0.0` on a host with a public interface is a deliberate exposure.
- **Authentication cannot be disabled.** The old `auth.disabled` / `auth.accessToken` switches are
  removed; a config that still contains them is warned about and dropped. Development uses real
  accounts too.
- **Grant the fewest permission bits that work.** Self-registered accounts start `pending` with
  nothing; `batch` (one command to N hosts) is separated from `terminal` for exactly this reason.
  Registration itself **cannot be switched off in the app** — if the instance is reachable beyond your
  network, deny `/api/auth/register` at the proxy. See
  [accounts-and-permissions.md](./accounts-and-permissions.md#registration-and-approval).
- **Protect the two halves of the secret separately.** MySQL holds encrypted credentials;
  `~/.aetherops/*.key` holds the ability to decrypt them. Anyone with both can read every stored SSH
  credential.
- **Audit is data, not a security control.** Command and transfer history is recorded per account in
  MySQL; it does not block anything by itself, and deleting an account purges its owner-scoped rows —
  export what you must retain before removing someone.
- **Rate limiting and brute-force protection are not built in.** Login has no lockout and no per-IP
  throttle; put that in the reverse proxy.
- Outbound requests are limited to your configured AI providers, the optional OpenRouter pricing
  catalog, and (desktop only) the GitHub releases endpoint. Nothing is sent home otherwise; see
  [README § Network egress](../README.md#network-egress--privacy).
