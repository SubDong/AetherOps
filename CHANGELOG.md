# Changelog

All notable changes to AetherOps are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Unreleased items are what `master` contains beyond the last tagged version. **This repository has no
release tags yet**, so there is no released baseline to compare against — treat `master` as the only
supported build, and record the commit you run.

## [Unreleased]

### Added

- **Open-source community files**: [LICENSE](LICENSE) (MIT, with the upstream attribution kept in
  `packages/vscode/LICENSE`), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), this
  changelog, and issue / pull request templates under `.github/`.
- **Bilingual documentation.** Every file in `docs/` now exists twice — `foo.md` (English) and
  `foo.zh.md` (Simplified Chinese) — each with a language switch line at the top, cross-links that stay
  inside their own language copy, and a row in both README tables. The two copies are **peers**: no
  "English wins" disclaimer, and
  [CONTRIBUTING.md](CONTRIBUTING.md#documentation) requires changing both in the same pull request.

### Changed

Nothing else pending. Add entries under `Added` / `Changed` / `Fixed` / `Removed` / `Security` as part of
the pull request that makes the change, not afterwards.

## 1.0.26 — 2026-11-02

The state of the fork at the time it was prepared for open-source publication. Version 1.0.26 is what
`package.json` carries; it has **not** been tagged, and no artifacts exist for it. Grouped by theme,
because the underlying history was written as a handful of large feature commits rather than release
increments.

### Added

- **Accounts and RBAC.** `users` table with `admin` / `user` roles, `pending` / `active` / `disabled`
  status and ten independent permission bits (terminal, batch, AI, connections, AI configuration,
  files, monitor, audit, skills, snippets). OAuth2-style bearer tokens stored as SHA-256 keys in Redis
  with a 7200 s sliding TTL, atomic single-session issue, permission snapshots that revoke a session on
  change, and `scrypt` password hashing. Self-service registration lands as `pending` with all bits
  off; the last usable administrator cannot be demoted, disabled or deleted.
- **MySQL-backed storage with versioned migrations.** Business data moved out of per-user JSON files
  into MySQL, every table scoped by `owner_id`; `schema_version` records applied migrations with a
  checksum, and pending migrations run automatically before the port binds.
- **Unified configuration layer.** Single `~/.aetherops/config.json` (mode `0600`, template generated
  on first run) with `server` / `database` / `redis` / `auth` / `debug` sections, an
  `AETHEROPS_*` environment namespace, documented precedence, and startup validation that fails loudly
  instead of half-loading.
- **Multiple AI provider profiles per account.** OpenAI, Anthropic, Tencent, Azure OpenAI and any
  OpenAI-compatible custom endpoint, with a live "Test" check, per-profile temperature, max tokens,
  enable flag and sort order.
- **Automatic model routing.** A virtual `auto` model scored locally per turn (instruction length, code
  present, action vs explanation, troubleshooting, context size, tool-chain depth, history length),
  mapped onto a 1–5 cost tier, matched against profile tiers with a measured health penalty. Reasons
  are surfaced in the UI; zero additional API calls.
- **Cost governance.** A public pricing catalog (OpenRouter, cached, best-effort, never guessed),
  derived cost tiers, `ai_usage` rows per call with a price snapshot fixed at write time, per-account
  budgets (`chatTokenLimit`, `dailyTokenLimit`, `dailyCostLimit`) enforced before the call, and a cost
  insights view including a `savedUsd` baseline comparison and a `partial` flag when prices are unknown.
- **Per-conversation AI chats** (`ai_chats`) with their own model binding, plus display history,
  tool-call steps, duration and token counts persisted per message.
- **OS-family-aware server status.** Target detection across Windows, macOS, Linux and
  HarmonyOS/OpenHarmony with a Unix-like fallback, per-family collection scripts, a single
  cmd/PowerShell-compatible Windows payload, UTF-8 handling for localized output, an honest
  `supported` flag per metric ("not collectable" instead of a fabricated zero), and a CPU history graph.
- **SFTP file manager** reusing the live SSH connection (browse, upload, download, mkdir, rename,
  delete) alongside in-terminal ZMODEM (`rz`/`sz`).
- **Command snippets library**, stored per account.
- **Admin oversight.** Member audit trails, file-transfer records, connection inventory with secrets
  stripped, live session listings, force disconnect, plus account create / update / reset-password /
  delete and emergency disconnect from the user-management view.
- **File-transfer auditing** as its own tool category: direction, path, bytes, duration, result.
- **Separate `batch` permission** (migration `0005`), seeded from `can_use_terminal` so existing
  accounts keep the access they already had.
- **VS Code extension host** (`packages/vscode`) that launches the same backend, adapts to the editor
  theme, and ships the backend runtime inside the VSIX; Electron desktop host for Windows/macOS/Linux
  with a GitHub Releases update check (notify only).
- **Build and release automation.** Docker image (multi-stage, Node 22, pnpm 10), GitHub Actions for
  desktop artifacts and the VSIX with Marketplace / Open VSX publishing, a pinned-dependency check, and
  verification scripts (`scripts/verify-auth.mjs`, `scripts/migrate.mjs`, `scripts/smoke-terminal.mjs`).
- Documentation set under `docs/` (eight topics, maintained as an English / Simplified Chinese pair
  each): getting started, configuration reference, deployment, accounts and permissions, AI models and
  cost, jump hosts, skills guide, troubleshooting.

### Changed

- Renamed from the upstream project: `AICMD_*` environment variables became `AETHEROPS_*`, the data
  directory `~/.aicmd` → `~/.aetherops`, VS Code commands → `aetherops.*`, the terminal probe marker →
  `__AETHEROPS_SYS__`.
- Startup order now validates configuration, probes MySQL and Redis and applies migrations **before**
  binding the port; an unavailable dependency aborts with a readable `[FATAL]` instead of leaving a
  listening server that errors on every query.
- Build chain standardized on **pnpm 10** across Docker, CI and local development; `@cicctencent/agent-core`
  and `vite` pinned to exact versions and verified before every build.
- Terminal WebSocket connections are refused (`1008`) unless the origin, the token and the `terminal`
  permission all check out; messages arriving during authentication are buffered and replayed instead of
  dropped, and high-frequency output is dropped under backpressure rather than blocking the shell.
- Jump-host sessions collect environment information from the **target** machine: cached context is
  ignored, an 8 s settle window waits for the hop, the OS family is probed before the script runs, and
  prompt lines are stripped from the captured output.
- `README.md` / `README.zh.md` rewritten against the current code; `docs/deployment.md`,
  `docs/jump-host.md` and `docs/skills-guide.md` rewritten — the previous revisions described the
  upstream single-user, file-based architecture.

### Removed

- The single global access token and the `auth.disabled` switch. Authentication cannot be turned off;
  those keys are read, discarded and reported as deprecated. Development uses real accounts.
- File-based persistence for connections, sessions, AI configuration, chat history and audit logs
  (they live in MySQL now). A first start still migrates an existing `~/.aicmd/` directory, including
  the `.key` files, so stored credentials remain decryptable.

### Known gaps at this point

Recorded here rather than hidden, and expanded in the README's *Known limitations* section:

- No per-account UI or API for creating skills; the table and service layer exist, the write path does not.
- `scripts/smoke-terminal.mjs` predates the account system and sends no token, so it cannot pass
  against a current build.
- The VS Code extension's **native sidebar** still calls `/api/connection/*` without a bearer token, so
  it reports `HTTP 401` while the WebView (where signing in works) is fine. Connection management inside
  the WebView is the working path; see `packages/vscode/README.md`.
- HarmonyOS support is verified against captured fixtures, not continuous real-device testing; CPU
  utilization may be unavailable on BSD-family targets.
- No high-availability mode: one server process, one Redis, one MySQL. Live terminal sessions are
  in-process state.
- No release tags or published artifacts yet; installation is from source or Docker.

### Attribution

AetherOps is a fork of [AICmd](https://github.com/fefeding/ai-cmd) by fefeding (MIT). The upstream
copyright notice is retained in [`packages/vscode/LICENSE`](packages/vscode/LICENSE). See
[LICENSE](LICENSE) for this repository's terms.
