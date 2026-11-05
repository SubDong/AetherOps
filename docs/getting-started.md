# Getting Started

**English** · [简体中文](./getting-started.zh.md)

This walkthrough takes you from an empty machine to an AI agent executing commands on a real server.
It assumes you are deploying for yourself or for a small team. Time: roughly 15 minutes if MySQL and
Redis are already reachable.

- [0. Prerequisites](#0-prerequisites)
- [1. Install and build](#1-install-and-build)
- [2. Prepare MySQL and Redis](#2-prepare-mysql-and-redis)
- [3. Configure the server](#3-configure-the-server)
- [4. First boot and the bootstrap administrator](#4-first-boot-and-the-bootstrap-administrator)
- [5. Create your first SSH connection](#5-create-your-first-ssh-connection)
- [6. Configure an AI provider](#6-configure-an-ai-provider)
- [7. First conversation](#7-first-conversation)
- [8. Optional: add teammates](#8-optional-add-teammates)
- [Next steps](#next-steps)

## 0. Prerequisites

| Requirement | Minimum | Why |
|-------------|---------|-----|
| Node.js | 22.17 | The agent engine declares `engines: { node: '>=22.17.0' }` |
| pnpm | 10.x | The lockfile is pnpm-10 shaped; see [CONTRIBUTING.md](../CONTRIBUTING.md#dependency-pinning) |
| MySQL | 8.x | Hard dependency |
| Redis | recent | Hard dependency (login tokens) |
| C++ toolchain | gcc/clang or VS Build Tools | node-pty, ssh2, cpu-features are native |

## 1. Install and build

```bash
git clone https://github.com/SubDong/AetherOps.git
cd AetherOps
npm i -g pnpm@10        # or: corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` runs the pin check first, then bundles the front-end into `dist/public` and compiles
`server/` into `dist/server`. If the pin check fails, your installed tree does not match the
lockfile — reinstall with `pnpm install --frozen-lockfile` rather than editing versions by hand.

Install pnpm explicitly at major 10. `corepack enable` alone is not enough: the repository has no
`packageManager` field on purpose (see [CONTRIBUTING.md](../CONTRIBUTING.md#dependency-pinning)), so
corepack would resolve whatever major it considers current — and a pnpm 11/12 install rewrites the
lockfile into a shape CI's pnpm 10 rejects.

## 2. Prepare MySQL and Redis

Create a database and a least-privilege account:

```sql
CREATE DATABASE aetherops CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'aetherops'@'%' IDENTIFIED BY 'change-me';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON aetherops.* TO 'aetherops'@'%';
```

The application creates and migrates its own tables. Those extra privileges are what let it do so;
if your policy forbids application-owned DDL, emit the SQL instead and let a DBA apply it:

```bash
node scripts/migrate.mjs --dump 0001 > 0001.sql   # repeat per migration version
```

Redis needs nothing but reachability. A password (or an ACL user) is strongly recommended whenever
Redis is not bound to localhost, because login tokens live there. No Redis modules are used.

## 3. Configure the server

On the first run the server writes a template to `~/.aetherops/config.json` with mode `0600`. It is
abridged here — the file carries more keys than the three groups below:

```json
{
  "server":   { "port": 9802, "host": "127.0.0.1" },
  "database": { "host": "", "port": 3306, "user": "", "password": "", "database": "aetherops" },
  "redis":    { "url": "", "host": "", "port": 6379, "password": "", "db": 0, "keyPrefix": "aetherops:" },
  "auth":     { "launchToken": "", "maxUploadMb": 100 },
  "debug":    { "sshDebug": false }
}
```

Fill in `database` and `redis` — or keep them empty and use environment variables so credentials
never touch the disk:

```bash
export AETHEROPS_DB_HOST=127.0.0.1
export AETHEROPS_DB_USER=aetherops
export AETHEROPS_DB_PASSWORD='change-me'
export AETHEROPS_DB_NAME=aetherops
export AETHEROPS_REDIS_HOST=127.0.0.1
export AETHEROPS_REDIS_PASSWORD='redis-secret'
```

Precedence is built-in defaults < config file < environment variables. Binding `0.0.0.0` is done
with `HOST=0.0.0.0` and only makes sense behind authentication and a network you control.

Full reference: [configuration.md](./configuration.md).

## 4. First boot and the bootstrap administrator

```bash
node server.js
```

Startup order is deliberate: validate config → connect MySQL → apply migrations → probe Redis →
initialize services → only then bind the port. A missing dependency exits with a readable message
instead of opening a port that errors on every request.

When the `users` table is empty, one administrator is created for you. Its password is random,
printed **once**, and not stored in any file other than the log:

```
[Auth] 已创建初始管理员  admin / <16-character password>
```

Grab it from the console or from `~/.aetherops/server.log`, open the printed URL
(<http://127.0.0.1:9802> by default), sign in as `admin`, and change the password immediately
(account menu → change password).

What the account model looks like underneath is covered in
[accounts-and-permissions.md](./accounts-and-permissions.md).

## 5. Create your first SSH connection

1. In the left sidebar choose **Connections → New** (the same dialog is reachable from the admin
   console when managing another member's inventory).
2. Fill host, port, username. Authentication can be key-based, password, or automatic.
   - Key: paste a private key, optionally with a passphrase. The key is stored as `enc:v1:`
     AES-256-GCM ciphertext in MySQL; the decryption key stays in `~/.aetherops/connections.key`.
   - The file `connections.key` is not backed up into the database — losing the data directory means
     losing stored credentials. Back the directory up.
3. Test the connection with the built-in test button before saving.
4. For a bastion, add a **startup script** (`ssh user@target.internal`) and tick **SSH agent
   forwarding**: [jump-host.md](./jump-host.md).

Open the connection: a tabbed terminal appears. The toolbar on the tab gives you the SFTP file
manager, the snippets panel and the **server status** panel (dockable in the sidebar, or floating).

## 6. Configure an AI provider

The agent needs at least one model profile. Open AI settings (gear icon in the chat header, or the
robot icon at the bottom of the sidebar).

- Provider: **OpenAI**, **Anthropic (Claude)**, **Tencent**, **Azure OpenAI**, or **Custom** for any
  OpenAI-compatible endpoint (DeepSeek, Qwen, a self-hosted gateway, …) via base URL + model name.
- You can save **multiple profiles per account** and label them. Labels are what appears in the
  model picker.
- Use **Test** before saving: it performs a real completion against the endpoint.
- Set a **cost tier (1 cheapest … 5 strongest)** per profile, or leave it on automatic and let the
  price catalog decide: [ai-models-and-cost.md](./ai-models-and-cost.md).
- API keys are encrypted at rest the same way SSH credentials are.

## 7. First conversation

With a terminal tab focused, the AI panel binds to that session — commands really execute there.

```
Check whether nginx is running and show the most recent errors in its error log
```

The agent detects the OS family first, then chooses platform-appropriate commands
(`systemctl` / `launchctl` / `Get-Service`), reads output back, and iterates. Try:

- `/server-health-check` — a built-in skill that collects metrics systematically
  ([skills-guide.md](./skills-guide.md))
- "Clean up Docker images older than 7 days and tell me how much space was freed"
- "Which process is eating memory right now?" — expect a generated script rather than five commands

Every command lands in the audit panel, including ones the safety layer blocked or rewrote
(destructive deletes are moved to `~/.aetherops/.trash/`).

If the agent answers that there is no terminal session, it means the AI panel was not bound to a
live one — open or reconnect a terminal first. This is intentional: it would rather stop than
invent output.

## 8. Optional: add teammates

The login page has a **register** link. Self-registered accounts are created as `pending` with all
permissions off, so anyone can request an account without anyone being able to use one. As admin,
open **account menu → user management** (`/users`) to:

- approve an account (status → `active`), or create it directly with a generated password,
- grant only the permission bits that person needs (`terminal`, `batch`, `ai`, `connections`,
  `aiConfig`, `files`, `monitor`, `audit`, `skills`, `snippets`),
- reset a password, force a logout, or delete the account,
- inspect a member's audit trail, file transfers, connections (credentials stripped) and sessions,
  and disconnect them if needed.

Connections, chat history, AI profiles, snippets and audit records are scoped per account: members
never see each other's data, and only `admin` may reach the oversight endpoints.

## Next steps

| Goal | Read |
|------|------|
| Run it on a server with Docker | [deployment.md](./deployment.md) |
| Every config key and environment variable | [configuration.md](./configuration.md) |
| Understand what the agent may and may not do | [../SECURITY.md](../SECURITY.md), [accounts-and-permissions.md](./accounts-and-permissions.md) |
| Cut AI spend | [ai-models-and-cost.md](./ai-models-and-cost.md) |
| Something is broken | [troubleshooting.md](./troubleshooting.md) |
