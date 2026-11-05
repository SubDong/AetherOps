# Security Policy

Short version: **report privately, do not open a public issue.** AetherOps hands an AI agent a real
shell on your servers, so a flaw here is closer to a compromised bastion host than to a broken web UI.
We take that seriously and will work with you on disclosure.

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [What we consider in scope](#what-we-consider-in-scope)
- [What is not a vulnerability](#what-is-not-a-vulnerability)
- [Supported versions](#supported-versions)
- [Threat model, as implemented](#threat-model-as-implemented)
- [Deployment hardening](#deployment-hardening)
- [Response process](#response-process)

## Reporting a vulnerability

Use GitHub's private reporting on this repository:

**Security → Advisories → Report a vulnerability**
(<https://github.com/SubDong/AetherOps/security/advisories/new>)

That form opens a private advisory; nobody outside the maintainers sees it, and you keep full credit in
the eventual advisory and changelog.

If private reporting is unavailable to you, open a **normal issue with the title `security` and no
details**, and we will reply asking you to move to a private channel. Do not describe the problem in
the public issue itself — the issue title is not a vulnerability disclosure.

Please include, as far as you are comfortable:

1. What is affected (host: web / Electron / VS Code; the version or commit you tested).
2. The preconditions — which permission bits, which configuration, whether the attacker needs an
   account.
3. Steps to reproduce, ideally against a fresh install. A short script or a recorded request beats a
   long narrative.
4. The impact you believe it has, and any mitigation you found.

We will acknowledge as soon as we see it (expect days, not hours — this is a volunteer-maintained
project), confirm or refute the finding, and agree a disclosure timeline with you. Public disclosure is
your call after a fix exists or after we have had a reasonable chance to ship one; please tell us your
intended date so we can be ready.

**Do not** scan or test against infrastructure you do not own or are not authorized to test, and do not
attempt to access other users' data on a shared public instance.

## What we consider in scope

Anything that breaks a guarantee this project explicitly makes:

- **Cross-account data access.** Connections, sessions, AI profiles/chats/messages, usage, budgets,
  audit events, snippets and user skills are scoped by `owner_id`. Being able to read or write another
  account's rows — including through an admin oversight endpoint used by a non-admin — is a serious
  report.
- **Authorization bypass.** Reaching a feature without its permission bit, hitting someone else's live
  terminal session by guessing a client-generated `sessionId`, becoming admin through a
  self-service path, or any route that skips the permission funnel.
- **Authentication weakness.** Accepting an invalid or revoked token, `?token=` being honored on
  ordinary HTTP endpoints (it is WebSocket-handshake-only by design), the origin allow-list being
  bypassable, tokens being recoverable from Redis in plaintext, or a timing/oracle difference that
  turns login into a username oracle beyond the documented behavior.
- **Credential exposure.** SSH passwords, private keys, passphrases or AI API keys appearing in
  plaintext in the database, in a non-owner view, in logs, in an error response, or in any export.
  The `stripSecrets` rule on admin oversight endpoints is a guarantee, not a nicety.
- **Filesystem escapes.** Path traversal or symlink escape in the file manager, upload
  (`normalizeUploadName`) or download paths, or writing outside the data directory's `.trash/` scope.
- **Safety-rail bypass.** A command that should be hard-blocked (`rm -rf /`, `mkfs.*`,
  `dd of=/dev/sd*`, fork bombs, `format C:`) or should be rewritten into the recycle bin executing
  anyway, when the account is supposed to be protected by those rails.
- **Server-side request forgery beyond configuration.** The "Custom" AI provider profile is by design an
  operator/user-supplied base URL, but if a low-privilege account can make the **server** hit internal
  endpoints and read back responses in a way that escapes its own tenant, tell us — that may need a
  permission gate or an allow-list.
- **Supply chain.** Pinned-dependency enforcement being bypassable (`scripts/check-engine-pin.mjs`),
  unpinned or writable GitHub Actions references, the release workflow being able to publish artifacts
  that were not built from the tagged commit, or the update check in `electron/updater.js` being
  spoofable into pointing users at attacker-controlled assets.
- **Anything with a real secret in it.** If you find credentials in this repository's history, report
  it immediately so we can rotate and rewrite.

## What is not a vulnerability

Documented design decisions and out-of-scope assumptions, listed so nobody spends a report on them:

- **The agent runs arbitrary commands on the target host** *for an account that has the `terminal` and
  `ai` bits.* That is the product. Prompt injection in terminal output or AI replies does not become a
  vulnerability unless it crosses a permission or tenant boundary.
- **Encrypted database rows are decryptable by whoever holds the data directory.** `~/.aetherops/*.key`
  sits next to the app by design; having both MySQL and the data directory means full credential access.
  See [docs/accounts-and-permissions.md](./docs/accounts-and-permissions.md#credential-handling).
- **No rate limiting, lockout or CAPTCHA on login**, and no switch to disable self-registration.
  Reported to your reverse proxy / WAF. Registered accounts land as `pending` with all permissions off,
  so the residual risk is row creation and username enumeration, which we consider acceptable and
  documented.
- **Single active session per account** kicking your other tab: intended behavior.
- **Missing transport encryption when you deploy `HOST=0.0.0.0` in the clear.** TLS is your proxy's job.
- **Vulnerabilities in software the deployment runs** (your MySQL, Redis, sshd, nginx) or in the
  third-party AI provider's response content.
- **Attacks requiring already-compromising access**: controlling the OS user running the server, the
  MySQL instance, Redis, or the data directory. At that point the credentials are simply exposed;
  that is the host, not the app.
- **Open-source components' known issues** at their published, documented versions, and
  best-effort-degradation behaviors described in [docs/troubleshooting.md](./docs/troubleshooting.md).
- **Theoretical** attacks with no working demonstration against the shipped default configuration.

If you are unsure whether something qualifies, report it privately anyway. A "not a problem, here is
why" answer is a perfectly good outcome, and we would rather read it.

## Supported versions

| Branch / version | Status |
|------------------|--------|
| `master` (current source) | Actively fixed; security patches land here first |
| The most recent tagged release | Fixed, once releases exist |
| Everything older | Best effort, usually no |

**No releases have been published yet** (this repository has no tags), so `master` is the only
supported build. If you are running a checkout, record the commit — it is the only way we can tell
whether you already have a fix.

## Threat model, as implemented

What the code actually guarantees, so a report can be framed against it:

| Guarantee | Mechanism | Where |
|-----------|---------|-------|
| Every account's data is separate | Explicit `owner_id` in every query; business tables keyed by owner | `server/db/repositories/*` |
| Features require a permission bit | One endpoint→permission table, checked before dispatch | `server/index.ts` |
| Only the owner drives their session | Per-`sessionId` ownership check, including the standalone file routes | `assertSessionOwner` |
| Admins oversee but cannot read credentials | Secret fields stripped, replaced by a `hasSecret` flag | `/api/admin/*` |
| Passwords are not recoverable | `scrypt` hash; constant-ish time on unknown users via a dummy hash | `auth.service.ts` |
| Tokens are revocable and short-lived | Redis, keyed by SHA-256 of the token, 7200 s sliding TTL, atomic single-session issue | `auth.service.ts` |
| Stored SSH/AI secrets are encrypted at rest | AES-256-GCM (`enc:v1:`), key in the data directory | `connection.service.ts`, `ai.service.ts` |
| Requests come from a known origin | `Origin` must equal `Host` or be localhost — for HTTP and the WS handshake | `utils/security.ts` |
| Destructive commands are stopped | Hard blocks and `rm` → recycle-bin rewrite, chosen by the **target's** OS family | `utils/shell.ts` + `ai.service.ts`, layered on top of what the agent engine enforces |
| Nothing is silently fabricated | Unsupported metrics report as unavailable; unknown prices report as unknown | status panel, `ai-pricing.ts` |

Guarantees deliberately **not** made: multi-instance/high-availability correctness, no information
leakage through the AI provider you configured (your prompts and terminal context go to them),
protection against a malicious administrator, and defense against someone who can already read the
data directory.

## Deployment hardening

The application is one third of the picture. If you operate this for others, please:

- Keep it inside a network you control (LAN, VPN, tailnet). Publish on `127.0.0.1` and tunnel, rather
  than opening the port.
- Terminate TLS in your proxy and pass `Host` and the WebSocket `Upgrade` headers correctly.
- Restrict `/api/auth/register` at the edge, and add rate limiting on `/oauth/token`.
- Give MySQL and Redis their own network, credentials and backups; do not expose them.
- Grant the fewest permission bits that work, and revoke `batch` where it is not needed.
- Back up the database **and** the `*.key` files together, and treat that backup as a credential dump.
- Review audit records regularly: they include blocked and rewritten commands, which is where a
  misuse attempt shows up first.
- Use a least-privilege account for what AetherOps connects to. The tool is only as damaging as the
  credentials it holds.

Details in [docs/deployment.md](./docs/deployment.md#operational-security).

## Response process

1. **Acknowledge** — we confirm receipt and give a first assessment. No fixed SLA; please bump after a
   week of silence.
2. **Verify** — reproduce against `master`, decide severity, and check whether it is exploitable with
   the default configuration or needs specific setup.
3. **Fix** — patch on a private branch where the exposure makes that sensible; add a regression check
   (usually a case in `scripts/verify-auth.mjs`).
4. **Coordinate** — we propose a disclosure date, prepare a GitHub security advisory with a severity
   assessment, and let you choose how you are credited.
5. **Publish** — advisory + changelog entry + a tagged release when releases exist, so "update to X" is
   an actionable answer.

We will not take legal action against, or threaten to take action against, anyone who reports a
problem in good faith and follows this policy. If you want your report to be credited in an advisory,
say so when you send it and include the name or handle you want used.
