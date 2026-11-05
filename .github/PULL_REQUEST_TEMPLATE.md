<!--
Thanks for the PR. Delete this comment block; keep the headings.

The three questions that decide how fast this gets reviewed are: what changes for a user running
this in production, why it is built this way, and what you actually executed. Fill in the
verification table honestly — "not tested" is an acceptable answer, a claimed test that did not
happen is not.

If this touches authentication, ownership scoping, migrations, the safety rails or a pinned
dependency, please read CONTRIBUTING.md first; each of those has a rule that exists because of a
specific failure.
-->

## What changes

<!-- One or two paragraphs. User-visible effects first: new config key, new permission bit,
migration required on upgrade, breaking rename, changed default. Then the internals. -->

## Why

<!-- The problem being solved, and why this design over the alternatives you rejected. Link the
issue if there is one (`Fixes #123`). -->

## Verification

What you actually ran, on which host and against which target OS. This project has no unit-test
suite, so this table *is* the test report.

| Item | Result |
|------|--------|
| `pnpm lint` | ☐ clean ☐ n/a |
| `pnpm type-check` | ☐ clean ☐ n/a |
| `pnpm build-only` (runs the pin check) | ☐ clean ☐ n/a |
| Host(s) exercised | web / Electron(win\|mac\|linux) / VS Code |
| Target OS family(ies) exercised | linux / macos / windows / harmony / unix |
| Accounts / permission bits used | |
| `node scripts/verify-auth.mjs` | ☐ passed (paste summary) ☐ not needed |
| `node scripts/migrate.mjs --status` | ☐ sane ☐ new migration applied ☐ n/a |
| Manual terminal / AI check | |

<!-- For verify-auth.mjs, paste the tail it prints. If you changed auth, permissions, ownership or
tokens and did not run it, say so — that is the difference between a quick review and a long one. -->

## Checklist

- [ ] No security issue reported in this PR or in code comments (use private vulnerability
      reporting; see SECURITY.md)
- [ ] Nothing sensitive in the diff, commits, screenshots or pasted logs — no secrets, internal
      hostnames, real usernames or customer data. This repository is public
- [ ] Schema change is a **new** migration module, re-entrant, and no applied migration was edited
- [ ] New endpoint registered in the endpoint→permission table in `server/index.ts`; if it accepts a
      `sessionId`, it also does the owner check
- [ ] New repository queries take `owner_id` explicitly (no implicit "current user")
- [ ] Any credential material goes through the existing `enc:v1:` path; no plaintext storage added
- [ ] Pinned dependency (`@cicctencent/agent-core`, `vite`) untouched, or changed via
      `pnpm run upgrade-pin` with `package.json` + `pnpm-lock.yaml` in the same commit and a note on
      what the new version changes behaviorally
- [ ] New UI strings added to **both** `src/locales/zh-CN.ts` and `en-US.ts`
- [ ] No fabricated data presented to the user (unsupported metrics stay "not collectable")
- [ ] [CHANGELOG.md](../CHANGELOG.md) `Unreleased` updated for anything user-visible
- [ ] `README.md`, `README.zh.md` and **both language copies** of every touched doc
      (`docs/foo.md` + `docs/foo.zh.md`) updated in this PR — an unpaired docs change is treated as
      incomplete. Cross-links inside a doc stay within its own language copy, and a new doc file needs
      the language switch line at the top plus a row in both README tables
- [ ] Docs state only what the code does today, including unfinished parts; every number in a doc
      re-verified against the source
- [ ] Comments follow the file they live in (Chinese-dominant in existing files); no bulk translation
      of unrelated comments bundled into a behavior change
- [ ] One topic per PR; formatting-only and behavior changes separated

## Notes for the reviewer

<!-- What you deliberately did not do, and why. Known rough edges. Places where you would have made
a different choice if the constraints were different. Anything you want a second pair of eyes on. -->
