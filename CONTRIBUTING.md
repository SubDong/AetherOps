# Contributing

Thanks for being interested. AetherOps is a small, self-hosted tool that gives an AI agent a real
shell, so the bar for changes is "safe to run against production servers", not "compiles".

- [Licence and conduct](#licence-and-conduct)
- [Set up a development environment](#set-up-a-development-environment)
- [Where code goes](#where-code-goes)
- [Code style](#code-style)
- [Test scripts](#test-scripts)
- [Dependency pinning](#dependency-pinning)
- [Database changes](#database-changes)
- [Authorization changes](#authorization-changes)
- [AI, cost and pricing rules](#ai-cost-and-pricing-rules)
- [UI and i18n](#ui-and-i18n)
- [Documentation](#documentation)
- [Commits and pull requests](#commits-and-pull-requests)
- [Where help is most useful](#where-help-is-most-useful)

## Licence and conduct

The project is MIT-licensed ([LICENSE](./LICENSE)). There is no CLA and no signed-commit requirement:
opening a pull request means you license your contribution under the same MIT terms, and you confirm
you have the right to submit it (no copied code you cannot license, no secrets, no internal hostnames
from your employer's infrastructure).

Be decent in issues and reviews. This is a volunteer-maintained project with no response-time
commitment; if you are waiting on something, a helpful nudge beats a deadline.

**Security problems are different.** Do not open a public issue for a vulnerability — follow
[SECURITY.md](./SECURITY.md).

## Set up a development environment

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 22.17 | Enforced by `@cicctencent/agent-core`'s `engines` |
| pnpm | 10 | The lockfile shape depends on it; see [Dependency pinning](#dependency-pinning) |
| MySQL | 8.x | Hard dependency — nothing starts without it |
| Redis | recent | Hard dependency — login tokens |
| C++ toolchain | platform-specific | `node-pty`, `ssh2`, `cpu-features` need build scripts |

```bash
git clone https://github.com/SubDong/AetherOps.git
cd AetherOps
npm i -g pnpm@10                   # or: corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile      # applies patches/zmodem.js.patch; do not skip the patch
pnpm build-only                     # pin check → vite build → tsc -p tsconfig.server.json

# point at your own MySQL/Redis (config file or env)
export AETHEROPS_DB_HOST=127.0.0.1 AETHEROPS_DB_USER=aetherops AETHEROPS_DB_PASSWORD=...
export AETHEROPS_REDIS_HOST=127.0.0.1

node scripts/verify-auth.mjs        # needs a running instance; see below
```

Daily loop:

```bash
pnpm dev            # Vite on 127.0.0.1:9801 with the backend mounted in-process
pnpm build-only     # full build, same as CI
pnpm type-check     # vue-tsc
pnpm lint           # eslint with --fix
```

`pnpm dev` still runs migrations before binding, so a broken database config shows up as a startup
error in the dev server, not as a runtime surprise.

**Bring your own target hosts.** Most meaningful behavior involves SSH somewhere. Safe options: an
SSH server in a second container on the same machine, or a throwaway VM. Do not develop against
production systems — the agent's delete protection is a guardrail, not a safety guarantee.

## Where code goes

| Area | Location | Read first |
|------|----------|-----------|
| HTTP entry, permission table, WS handling | `server.js`, `server/index.ts` | [docs/accounts-and-permissions.md](./docs/accounts-and-permissions.md) |
| Account routes / tokens | `server/routes/auth.routes.ts`, `server/service/auth.service.ts` | same |
| Business services | `server/service/*.ts` | the service you are touching |
| SQL | `server/db/repositories/*.repo.ts`, `server/db/migrations/` | [docs/configuration.md](./docs/configuration.md#database-schema-and-migrations) |
| Config keys | `server/utils/config.ts` | [docs/configuration.md](./docs/configuration.md) |
| OS detection & metric scripts | `server/utils/os-detect.ts` | [docs/troubleshooting.md](./docs/troubleshooting.md#server-status-panel) |
| Vue front-end | `src/components/`, `src/views/`, `src/service/`, `src/locales/` | `src/platform/router.ts` for route wiring |
| VS Code host | `packages/vscode/` | `packages/vscode/README.md` |
| Electron host | `electron/`, `scripts/electron-*.js` | [docs/deployment.md](./docs/deployment.md#desktop-and-vs-code-packaging) |
| Build/release automation | `scripts/`, `.github/workflows/`, `Dockerfile` | [docs/deployment.md](./docs/deployment.md#cicd-release-flow) |

Three host entry points share one backend. If you change server behavior, check it does not break the
Electron and VS Code embeds (they launch the same `server.js` and inject `AETHEROPS_LAUNCH_TOKEN`).

## Code style

- ESLint and Prettier extend **mwts** (`.eslintrc.json`, `.prettierrc.js`), with
  `endOfLine: 'auto'` and unused variables allowed when prefixed with `_`. Run `pnpm lint` before
  pushing; do not hand-format unrelated files — a formatting wave makes a review impossible.
- TypeScript on both sides. Server code targets `tsconfig.server.json`; front-end types come from
  `vue-tsc` (`pnpm type-check` must pass).
- **Comments are mixed Chinese and English.** Most server and front-end comments are Chinese, inherited
  from the upstream project. Follow the file you are editing; do not mass-translate comments inside a
  behavior-change PR. A dedicated translation PR is a reasonable contribution — open it as its own
  discussion first so we can agree on scope.
- Comments should explain *why*, including the failure you are preventing. Several existing comments
  record a measured fact ("pool size 5 because the shared instance has `max_connections=50`") — that is
  the level of detail worth writing, and it is why reviewers do not have to re-derive it.
- No new runtime dependency without justification in the PR description: every dependency is a supply
  chain surface and needs a matching lockfile change.

## Test scripts

There is **no unit-test suite** in this repository. Verification is script-based and runs against a
live instance:

```bash
BASE=http://127.0.0.1:9802 ADMIN_USER=admin ADMIN_PASS=<password> \
  node scripts/verify-auth.mjs
```

`verify-auth.mjs` asserts real behavior end to end: token issue and 7200 s expiry, `pending` accounts
getting 403, permission enforcement, cross-account data isolation, single-session takeover, sliding
renewal (it pokes Redis directly to shorten a TTL), no-renewal-when-fresh, revoke, delete-account
purging owner rows, uniform `invalid_grant` on a bad password, WS handshake with and without a token,
and that `?token=` is accepted only on `/ws/`. It exits non-zero on failure and prints a pass count.
**Run it after any change to authentication, permissions, isolation or tokens**, and say so in the PR.

`node scripts/migrate.mjs --status` shows schema state; `--dump <ver>` emits plain SQL so a change can
be reviewed by someone who cannot run MySQL locally.

Known gap: `pnpm run smoke` (`scripts/smoke-terminal.mjs`) exercises
WS → node-pty → output, but it predates the account system and sends no bearer token, so it fails at
its first API call against a current build. Adding a login step to it (read `ADMIN_USER` /
`ADMIN_PASS`, call `/oauth/token`, attach `Authorization`) is well-scoped and useful.

Anything beyond scripts needs a real browser and real hosts. For a PR, list what you exercised:
which host (web / Electron / VS Code), which target OS family, which permission bits.

## Dependency pinning

`@cicctencent/agent-core` (the agent engine — its ReAct loop, built-in tools and command blacklist are
a black box) and `vite` (it determines the front-end output) are **pinned to exact versions**, and
`scripts/check-engine-pin.mjs` runs before every build (`build-only`, Electron packaging, CI, Docker).
It fails when:

- the declaration is a range (`^`, `~`, `x`, `latest`, `||`);
- the installed copy does not match the declaration;
- `pnpm-lock.yaml` is missing, or its `patchedDependencies` block is in the one-line shape written by
  pnpm 11/12 — CI's pnpm 10 rejects that under `--frozen-lockfile`
  (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`), and the local install would not have complained.

Native-module build permissions live in **`pnpm-workspace.yaml`, in two keys with different readers**:
`onlyBuiltDependencies` (pnpm 10/11) and `allowBuilds` (pnpm 12+, `true`/`false` per package).
`package.json#pnpm` keeps a shorter list plus `patchedDependencies` so an older pnpm that ignores the
workspace file still gets the essentials. Keep all three consistent when adding a dependency with a
build script — an entry missing from the workspace file means the module is installed uncompiled and
fails at runtime, not at install time.

One pnpm-12 quirk to watch for: its first install may prepend its own `allowBuilds:` placeholder
block (`set this to true or false`). Two `allowBuilds` keys make the whole file fail to parse, so
delete the placeholder — if `pnpm install` suddenly reports an invalid workspace file, check that
before debugging anything else.

To upgrade one of the pinned packages:

```bash
pnpm run upgrade-pin -- @cicctencent/agent-core@<version>   # rewrites declaration, refreshes lock, re-verifies
```

Commit `package.json` and `pnpm-lock.yaml` in the *same* commit, and describe what the new engine
version changes in agent behavior. Upgrades that only say "bumped deps" will be asked to expand.

If your pnpm rewrote the lock as a side effect of any install, restore it (`git checkout pnpm-lock.yaml`)
rather than committing a diff you did not intend. There is deliberately no `packageManager` field: it
makes newer pnpm versions wipe and rebuild `node_modules`, including native modules. The cost of that
choice is that the pin is documentation-only, so name the major explicitly when you install —
`npm i -g pnpm@10`, or `corepack prepare pnpm@10 --activate` if you use corepack. A bare
`corepack enable` with no `packageManager` resolves to whatever major corepack considers current,
which is exactly how a pnpm 11/12 lockfile ends up in a PR.

`patches/zmodem.js.patch` is not optional. Without it `rz`/`sz` regress to unreliable, and nothing at
runtime will tell the user why.

## Database changes

- New versioned module in `server/db/migrations/`, applied in order at startup, recorded in
  `schema_version` with a checksum over whitespace-normalized SQL.
- **Never edit an applied migration.** Add a new one. The checksum check exists to catch exactly the
  case where a schema in production no longer matches the file that claims to have created it.
- Every statement must be **re-entrant**: a failed migration is not recorded and is retried on the next
  start, so wrap `ALTER` in an `information_schema` existence check plus `PREPARE` (copy the pattern
  from `0002`–`0005`).
- Schema conventions: snake_case identifiers; no `ENUM` (the default collation is case-insensitive);
  no foreign keys; `DATETIME(3) NOT NULL` with **no** database-side default — the app supplies UTC
  `Date` values, never `NOW()`.
- A new business table needs `owner_id` as part of its primary key (or an equivalent scoping column)
  with **no default value**, so a forgotten owner fails under strict mode instead of writing rows
  nobody can query.
- Do not add a way to store a plaintext secret. If a column holds a credential, it must go through the
  existing `enc:v1:` AES-256-GCM path.

## Authorization changes

The full model is in [docs/accounts-and-permissions.md](./docs/accounts-and-permissions.md). The rules
that matter for a diff:

1. Permission checks stay in the single funnel (`assertPermission` / `assertAdmin` /
   `assertSessionOwner`), not scattered inside services.
2. A new endpoint must be registered in the endpoint→permission table (`server/index.ts`). Unlisted
   endpoints require login only, on purpose — so an unregistered endpoint is a hole you just opened.
   If a new endpoint takes a `sessionId`, it also needs an owner check (see how the standalone
   file-transfer routes re-check for themselves).
3. Every repository query takes `owner_id` explicitly. The services are process-global; there is no
   "current user" to fall back to, and an implicit one would leak the previous request's identity.
4. Secret material is stripped from any non-owner view (`stripSecrets` → `hasSecret` only).
5. Do not reintroduce a way to disable authentication. `auth.disabled` / `auth.accessToken` are
   deprecated on purpose and development uses real accounts.
6. Re-run `verify-auth.mjs` and paste the summary into the PR.

## AI, cost and pricing rules

Design rationale lives in [docs/ai-models-and-cost.md](./docs/ai-models-and-cost.md). Non-negotiables:

- Auto routing stays **local, deterministic and explainable**. Keep the reason tags in the log and in
  the UI, so a user can see why a model was picked.
- Never substitute `0` for an unknown price, and never guess a cost tier silently. Unknown is a valid,
  required display state.
- Cost recorded in `ai_usage` is a snapshot at write time; later price changes must not rewrite history.
- A successful completion with no `usage` in the response is not recorded (a 0-token row corrupts
  averages).
- Bookkeeping never breaks the user's turn: record after forwarding the response, and swallow the
  recording error with a warning.
- New providers extend the catalog prefix mapping in `ai-pricing.ts`, not a hard-coded price table.

## UI and i18n

- Every new string needs **both** locale files (`src/locales/zh-CN.ts` and `en-US.ts`). Adding a key to
  one and not the other produces a silent fallback in the other language.
- Components are small and colocated (`src/components/<area>/`); state changes across panels go through
  the event bus (`src/base/eventBus.ts`) rather than reaching into another component.
- Match the existing terminal-first layout; do not introduce a new CSS framework. Reuse the current
  panel/toolbar patterns.
- Never present fabricated data. If a metric is unsupported on a platform, keep the
  "not collectable" rendering — the honest empty state is a feature.
- Include a screenshot for user-visible changes, and mention which host you tested on.

## Documentation

`docs/` is bilingual and the two copies are **peers** — there is no "authoritative" language, and no
disclaimer that the English text wins.

- Every file in `docs/` exists twice: `foo.md` (English) and `foo.zh.md` (Simplified Chinese), with a
  language switch line at the top of each that links to the other. Cross-links inside a document point
  at the **same language** copy (`./deployment.zh.md#…` from the Chinese file, `./deployment.md#…` from
  the English one); links out to English-only community files (`CONTRIBUTING.md`, `SECURITY.md`,
  `CHANGELOG.md`, `packages/vscode/README.md`) keep their English path from both copies.
- **Change one, change the other, in the same PR.** A behavior change, a new config key, a measured
  number — all of it lands in both files. An unpaired doc PR is treated as incomplete, the same way an
  i18n PR that adds a key to only one locale file would be.
- Keep the structure mirrored: same section order, same tables, same code blocks. Prose is translated,
  identifiers, commands, log strings, config keys and file paths are not. Anchor-sensitive links need
  the target language's real heading text, because the Chinese headings produce different anchors.
- Community files (`CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`) and the VS Code extension README
  are English-only for now; `README.md` / `README.zh.md` stay section-mirrored as they are today.
- Docs describe what the code does today, including the parts that are unfinished. If a capability has
  no write path, say so (the skill authoring case is the standing example) rather than describing an
  idealized feature.
- Prefer a "why this constraint exists" sentence over a bare rule. Measured numbers in docs
  (800 ms, 7200 s, 4 MB, 8 s timeout) came from reading the code — keep them accurate; verify against
  the source before writing a number down, and fix the English original first if the number is wrong,
  so the mistake is not translated into a second language.
- New top-level doc means a new pair of files plus a row in the table in both READMEs. Keep one topic
  per file; docs are organized by functional area, not by file name.

## Commits and pull requests

Subjects follow Conventional Commits with a scope; the body may be Chinese or English, as long as it
explains the reason:

```
feat(admin): 批量操作独立权限、管理员成员代管与文件传输审计
fix(ai): 工具改用 context.custom 绑定的终端会话，不再拿 chatId 去查会话
build(deps): 钉死依赖版本并把构建链统一到 pnpm 10
```

Types in use: `feat`, `fix`, `build`, `docs`, `refactor`, `test`, `chore`.

Before opening a PR:

1. `pnpm lint`, `pnpm type-check`, `pnpm build-only` all clean.
2. `node scripts/verify-auth.mjs` passing if you touched anything auth- or owner-scoped.
3. Migration state sane (`node scripts/migrate.mjs --status`) if you touched the schema.
4. No secrets, internal hostnames, real usernames or customer data anywhere in the diff — including
   screenshots and logs. The repository is public.
5. One topic per PR. Split "refactor + behavior change + formatting" into reviewable steps.

In the PR description: what changes, why, how you verified it, and what you deliberately did not do.
Note user-visible effects (new config key, new permission bit, migration required on upgrade, breaking
rename) at the top — those are the lines an operator reads.

Migrations and behavior changes need a changelog entry in [CHANGELOG.md](./CHANGELOG.md) under
`Unreleased`.

Maintainers are volunteers; a PR may sit for days. Bumping with something concrete ("rebased, here is
the updated test output") is welcome; "any update?" is less so.

## Where help is most useful

Things that are known gaps rather than bugs, in rough order of how much difference they make:

1. **Real-device testing for HarmonyOS / OpenHarmony targets** — detection is fixture-verified only.
   Reports with raw probe output, or a CI runner that can reach such a device, are both valuable.
2. **Make `scripts/smoke-terminal.mjs` authenticate** so the terminal pipeline is actually covered.
3. **Give the VS Code extension host a token.** `ServerLauncher.getConnections()` /
   `deleteConnection()` POST to `/api/connection/*` with no `Authorization` header, so the native
   sidebar shows `HTTP 401` against the account system while the WebView (where a user can sign in)
   works. Either have the extension perform a login and reuse the token, or drop the direct API calls
   and let the WebView own connection management — a small, well-contained change with visible payoff.
4. **Per-account skill authoring** — the table and service functions exist; the owner-scoped write
   endpoints and UI behind the `skills` permission bit do not.
5. **Proofreading the Chinese docs** (`docs/*.zh.md`) against how a native ops reader would phrase
   things, and keeping the pair in sync when the English text changes; English comments replacing the
   Chinese ones still in `server/` are also welcome.
6. **CPU metrics on BSD-family systems**, and any other platform where the panel currently says
   "not collectable".
7. **Pricing catalog sources** beyond OpenRouter, so self-hosted gateways get real tiers.
8. Reviewing any change to the safety rails (delete protection, hard blocks) with the assumption that
   someone will run it on a production box tomorrow.
