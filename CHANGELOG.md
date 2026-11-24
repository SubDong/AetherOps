# Changelog

All notable changes to AetherOps are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Unreleased items are what `master` contains beyond the last tagged version. `v0.0.1-beta.1` (2026-11-10)
was the first tag and `v0.1.0` the second; the latter is also where the version number was reset to this
project's own scheme, so the `1.0.26` section below is a snapshot of what the fork inherited, not a
predecessor release. Version numbers are plain `major.minor.patch` with no `-beta` suffix, because the
built-in update check compares them numerically (`Number("0-beta")` is `NaN`, so a suffix silently means
"already up to date"); beta status is carried by the `0.x` line and the release label. Record the tag —
or the commit, for a build that predates one — that you run.

## [Unreleased]

### Added

- **A read-only watch token, so an always-on screen no longer has to hold a login session.**
  Migration `0012` adds `auth_watch_tokens` — one row per issued token, scoped by `owner_id`, storing
  the SHA-256 of the token rather than the token itself, with an absolute `expires_at`, a `revoked_at`
  and a `last_used_at`. `/api/auth/createWatchToken` returns the plaintext exactly once,
  `listWatchTokens` reports label / state / created / expires / last used, `revokeWatchToken` kills one
  row. A token carries the `aow_` prefix, arrives as `kind: 'watch'` on the auth context, holds only
  the `monitor` bit, and `/api/watch/overview` answers in one round trip with the alert counts and
  latest rows, the open incidents, per-host metric summaries and a whitelisted connection list. The
  *Account → Watch tokens* page issues with an optional label and offers copy / *Open wallboard*;
  `/watch` is a public route rendering a dark wallboard — five counters, one card per connection
  (CPU / memory / disk, marked stale after 10 minutes without a sample), the alert table and the
  incident table — that refreshes every 30 s, every 120 s while the tab is hidden, and stops instead
  of retrying once the token is refused. **Boundary:** the prefix gate lives in `handleRoutes`
  (`kind === 'watch'` admits only `/api/watch/*`) and not in the permission table, because the token's
  permission bit *is* `monitor` and `/api/monitor/*` / `/api/alerts/*` ask for the same one; account
  routes refuse a watch token outright, so it cannot change a password, issue another token or manage
  accounts; no terminal, no file transfer, no batch — the WebSocket handshake never accepts the
  prefix, and the three hosts (`server.js`, the Vite dev middleware, Electron IPC) pass `allowWatch`
  only for paths under `/api/watch/`; the token **never renews** — `expires_at` is fixed at issue time,
  so an expired token means issuing a new one and there is no "valid forever" option; it is not a
  session and never occupies the single-session slot, so the wallboard and an operator's browser can
  be logged in as the same account at the same time; every authenticated request reads the row — that
  is what makes revocation immediate — at the cost of one indexed `SELECT` per poll; a `disabled`
  account or a withdrawn `monitor` bit kills the token without touching the row; `last_used_at` is
  written at most once per 5 minutes; deleting an account clears its token rows with the rest of its
  data, and issuing prunes rows that expired more than 7 days ago; `auth.watchTokenTtlSeconds = 0`
  disables issuing. Asserted in `scripts/verify-auth.mjs` — issue, read `/api/watch/overview`, any
  non-watch API 401, the operator's own session still alive, revoke, 401. The deployment
  answer for "a screen that outlives a session" — give the screen its own account — is in
  [docs/deployment.md](docs/deployment.md#the-on-call-wallboard) /
  [docs/deployment.zh.md](docs/deployment.zh.md#值班大屏); the token model and the two gates are in
  [docs/accounts-and-permissions.md](docs/accounts-and-permissions.md#read-only-watch-tokens) /
  [docs/accounts-and-permissions.zh.md](docs/accounts-and-permissions.zh.md#只读监控令牌).
- **Alerts can be handed to a person: claim, assignment, an on-call roster, and rule-based
  incidents.** Migration `0011` adds `alerts.assignee_id` / `alerts.incident_id` (with the two
  indexes the list actually filters on), a new `incidents` table and `alert_oncall`. *Claim* is one
  click that acknowledges the row **and** puts your name on it; *Assign* moves only the assignee —
  the first acknowledger is kept (`acked_by` is not overwritten by a later claim), because "who saw
  it first" and "who owns it now" are two different facts. Assignment only accepts active accounts,
  and the list renders the account id as a display name. The on-call roster is account +
  minute-of-day window (`start > end` means the window crosses midnight, and it is half-open, so a
  shift ending at 08:00 hands over to the one starting at 08:00); it decides **only** who is
  @-mentioned in the webhook payload (`onCall: { userId, username, displayName, mention:
  '@username' }`) — no new notification channel, no mail, no IM: that stays the receiver's job.
  Incidents are rule-based: three unresolved alerts on the same connection within a rolling 30
  minutes become one incident, later hits on that host join it, a manual *Merge* action attaches a
  row by hand, and an incident closes itself when its last alert is resolved. **Boundary:** no
  root-cause inference — the grouping says "these looked like one event", nothing more; the
  threshold counts rows whose `last_seen` falls inside the window, so an alert older than 30
  minutes neither counts toward the third hit nor gets attached by it; two connections never merge,
  because "same host" is the only evidence available; assignment is a label and not a permission —
  an assignee still needs the `monitor` bit to open the panel, and an empty string clears it;
  claiming or assigning sends no webhook, since delivery still fires only on *created* /
  *escalated*; incidents have no delete path — they are pruned together with their alerts after the
  30-day retention, and an `open` one is never pruned. Asserted in `scripts/verify-p6-collab.mjs`.
  Documented under `alerts` in [docs/configuration.md](docs/configuration.md#alerts) /
  [docs/configuration.zh.md](docs/configuration.zh.md#alerts).
- **`recall_fix`: how this exact error was fixed last time.** A failure that looks familiar can now
  be answered from data instead of a fresh guess: give the error line (or its 16-character
  fingerprint) and the tool returns up to three `execute_command` rows on that host which succeeded
  *after the error first appeared* and whose own output no longer carries the error, newest first,
  each with host and timestamp. Two details are the whole point. The time floor is
  `error_fingerprints.first_seen`, not `last_seen`: keyed on the latest sighting, the command that
  fixed the *first* occurrence falls outside the window and the tool would answer "nothing found"
  precisely when it has the answer. And a zero exit code is not a fix: a `service nginx restart`
  that returns 0 while its output still ends with the same `[emerg]` is filtered out, so the model
  is not handed the command that already failed. **Boundary:** it only reads stored history and
  never dials a host; it only knows commands executed through this app, so a fix typed by hand into
  a terminal is invisible and the answer says so when the candidate list is empty; the host defaults
  to the terminal this chat is attached to and has to be passed explicitly when there is none; a
  failure that was never recorded as a fingerprint returns `FINGERPRINT_NOT_FOUND` rather than an
  empty answer; `run_on_hosts` results are not candidates (one row covers N hosts, so it cannot be
  attributed to one machine). Asserted in `scripts/verify-p6-collab.mjs` — the "fixed once, broke
  again" fixture, with a second command that exited 0 without fixing anything, returns exactly the
  one real fix.
- **Per-account skills can be written from the UI.** Until now the `skills` table had a schema and a
  service layer but no write path, so a new skill meant editing `data/skills/*.md` — which also made
  it shared by everyone and impossible to remove from the app. `/api/ai/saveSkill` and
  `/api/ai/deleteSkill` (gated by `skills` + `ai`) now create, update and delete a skill owned by
  one account, and the skills panel carries the editor: id, name, one-line purpose, tags and the
  Markdown body. An id must match `^[a-z0-9][a-z0-9._-]{0,63}$`, a built-in id cannot be
  overwritten, the body must be non-empty and at most 20,000 characters, and tags are trimmed,
  de-duplicated and capped at eight. Deleting an id that does not exist — or that belongs to a
  built-in — answers 404 instead of 200-with-nothing. **Boundary:** user skills only — the built-in
  playbooks in `data/skills/` stay files on disk and read-only in this editor; a saved skill reaches
  the model on the *next* turn, because the catalog is built per run, not mid-stream; `load_skill`
  and the catalog both read the caller's own rows, so one account's skill is invisible to another.
- **Queued messages in the AI chat, so a follow-up no longer has to wait for the turn to end.** The
  input box used to be disabled while a turn ran. It now stays editable: Enter — or the send button,
  which turns into a queue button — appends the message to a queue drawn above the input. Each row
  carries the message, its skill badge, an edit action and a delete action. The head of the queue
  is sent as soon as the turn ends (`done`, `error` or a stop): that is what makes a series of
  instructions possible without babysitting the panel. Editing pulls a row out of the queue and puts
  its text in the input box; sending or cancelling returns it *at its original position*, so editing
  does not silently reorder the queue. Queued items enter the transcript only when they are actually
  sent, so a question never lands in front of the answer it was queued behind. A stopped answer
  carries a *Stopped (answer incomplete)* badge, and the client finalises the turn after 8 s if
  the provider never closes the stream. **Boundary:** the queue belongs to one chat and is cleared
  when another chat is opened or a new one is started; it lives in the tab's memory rather than the
  database, so reloading the page drops it; if creating the chat row fails, the queue stays parked
  and resumes on the next send instead of replaying the same failure once per item.
- **Per-minute host metrics retention + a `query_metrics` tool.** A server-side timer samples every
  60 s (first round 15 s after boot), reusing the panel's `SystemStatusService` so both report the same
  numbers, and merges each sample into a new `host_metrics_minute` table — one row per owner /
  connection / minute holding the average, peak and sample count for CPU %, memory %, disk % and load
  1/5/15, plus disk capacity, with a 7-day retention. The agent gets a third built-in tool beside
  `execute_command` / `read_terminal`: `query_metrics` answers questions about the past — average,
  maximum with its timestamp, minimum, trend, and how many minutes sat above 80 % CPU / 90 % memory /
  85 % disk — over a window of 1 minute to 24 hours, which no single `top` snapshot can do. Rows are
  scoped by `owner_id`, and a metric the platform cannot report is stored as `NULL` rather than `0` —
  so is the first CPU sample of a session, which has no previous sample to diff against.
  **Boundary:** the collector walks the list of live sessions and never opens a connection by itself,
  so a host nobody is connected to has no history for that period, and a three-minute session leaves
  three minutes of history; an empty window says so explicitly instead of returning zeros. Sampling
  idle hosts through a connection-driven scheduler is a separate, opt-in switch — see the next entry.
  See [README.md](README.md#host-metrics-history--query_metrics) and
  [README.zh.md](README.zh.md#主机指标留存与-query_metrics).
- **Optional unattended sampling (`metrics.offlineSampling`) with a per-connection `sampling: 'skip'`
  opt-out.** Off by default. When enabled, the collector also samples hosts that have **no** open
  terminal, by building a one-shot SSH channel from the saved connection: one handshake per host per
  minute, 2 in parallel, 45 s of round budget, a rotating cursor so a candidate list longer than one
  round's capacity is not starved, and a per-connection hash that staggers each host's first sample
  across the minute so enabling the switch does not fire every host at once. Failures back off
  exponentially (1→2→4→8→15 min, and 30 min upward when authentication itself fails, which is what
  `fail2ban` notices), with the log line throttled to once per 10 minutes. Hosts that do have a live
  session keep using it, so the switch adds logins only where there would otherwise be no data. Every
  dial is a real SSH login the target's `sshd` auth log will show — hence off by default, hence
  migration `0008` adding `connections.sampling` (`''` = follow the global switch, `skip` = never dial
  this connection unattended; it affects neither opening a terminal nor the status panel). The
  connection's `startupScript` is not replayed, so a jump-host connection is sampled on the machine it
  actually logs into — the bastion, matching the status panel. A stored baseline older than 5 minutes
  is discarded rather than diffed against, so a sample that resumes after a gap is not averaged across
  the whole of it. Documented under `metrics` in
  [docs/configuration.md](docs/configuration.md#metrics) / [docs/configuration.zh.md](docs/configuration.zh.md#metrics),
  with the four questions that come up before enabling it — default-off rationale, jump-host target,
  failure backoff, per-connection `skip` — in [docs/offline-sampling-faq.md](docs/offline-sampling-faq.md) /
  [docs/offline-sampling-faq.zh.md](docs/offline-sampling-faq.zh.md).
- **A per-connection sampling drop-down in the connection editor.** The connection form now carries
  its own collapsible *Offline sampling* card — *Follow the global setting* (the default) or *Skip
  (never dial this host)* — which writes `sampling: 'skip'`, until now reachable only through the
  API or a direct `UPDATE` even though the README and the FAQ described it as a form setting.
  Connections marked `skip` carry a `no sampling` badge in the connection list, so the exceptions
  are visible where the connections are listed instead of having to open each one. The form submits
  the field on every save, empty string included, because that is the only way a user can undo a
  `skip` set elsewhere; an absent field still means "keep the current value", so other clients are
  unaffected. See [docs/offline-sampling-faq.md](docs/offline-sampling-faq.md).
- **`search_audit`: the agent can search its own command history.** `audit_events` has carried
  `connection_id` since the first migration, but only in the `SELECT` list — never in the `WHERE`
  clause — so "what did we run on this host before, and what did we do about it" could not be asked.
  The repository now filters on `connection_id` and on an `occurred_at` range (served by the existing
  `idx_audit_occurred`, so no migration), `/api/audit/getLogs` accepts the same field, and a fourth
  built-in tool exposes the table to the agent: keyword, host, status, tool and a window of 1 hour to
  30 days, capped at 50 rows per call and rendered as two lines per entry so a long tail cannot flood
  the context. The system prompt lists it beside `query_metrics` and adds a working principle to check
  history before guessing. Owner scoping is unchanged — the account comes from the run context, never
  from tool arguments — and an empty result names the coverage gap instead of implying the command
  never ran. **Boundary:** only what this app ran is recorded (agent tool calls and file transfers);
  commands typed by hand into a terminal are not in the table. The tool's own calls land in
  `audit_events` through the same `after_tool` hook as every other tool. See
  [README.md](README.md#command-audit--replay) / [README.zh.md](README.zh.md#命令审计与回放).
- **Three reach tools: `list_connections`, `read_file`, `run_on_hosts`.** The agent could run one
  command in the terminal it was bound to and search stored history; it could not see the rest of the
  account's estate. `list_connections` returns id / name / type / host / user / enabled plus which of
  them currently hold an open terminal session — never a password, key or passphrase, because the
  entity it reads is already decrypted and the output is rebuilt from a field whitelist. `read_file`
  returns the head of a config or log file on such a host over the existing SFTP channel, reading a
  byte range instead of the whole file: the file-transfer path buffers up to 200 MB and a 2 GB log
  would take the process with it, so it stats first and reports `truncated` instead. Credential-shaped
  paths (`/etc/shadow`, `~/.ssh`, cloud/registry configs, `*.pem` / `*.key` / `id_*`) are refused, and
  that policy is deliberately *not* the monitor's `isSensitiveLogPath` — the latter bans all of `/etc`
  because its path is concatenated into `tail -f`, which would make `/etc/nginx/nginx.conf` unreadable
  here. `run_on_hosts` runs one command across up to 10 connections, or across every connection with
  an open session, reusing `BatchService` in chunks of 2 with a 45 s total budget and a per-host
  timeout (the batch panel keeps its own concurrency, untouched), and refuses high-risk commands before
  the fan-out instead of once per host. **Boundary:** none of the three dials a connection — they reach
  only hosts that already have an open terminal session and say so rather than reporting the host as
  unreachable; `scope=all_open` skips connections marked `sampling: 'skip'`; each tool is gated by its
  own permission bit (`connections` / `files` / `batch`) passed down from the WebSocket user, and a
  missing bit denies instead of defaulting to allow; all three are audited through the same
  `after_tool` hook. See [README.md](README.md#ai-agent) / [README.zh.md](README.zh.md#ai-agent).
- **Open-source community files**: [LICENSE](LICENSE) (MIT, with the upstream attribution kept in
  `packages/vscode/LICENSE`), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), this
  changelog, and issue / pull request templates under `.github/`.
- **Bilingual documentation.** Every file in `docs/` now exists twice — `foo.md` (English) and
  `foo.zh.md` (Simplified Chinese) — each with a language switch line at the top, cross-links that stay
  inside their own language copy, and a row in both README tables. The two copies are **peers**: no
  "English wins" disclaimer, and
  [CONTRIBUTING.md](CONTRIBUTING.md#documentation) requires changing both in the same pull request.
- **`pnpm docker:build`** (`scripts/docker-build.mjs`) as a one-command image build. It runs the checks
  that would otherwise only surface halfway through the build — the files the `Dockerfile` copies,
  whether the daemon is reachable, whether `.dockerignore` leaks a local build artifact or a foreign
  `node_modules` into the context, and whether the working tree is dirty — then tags
  `aetherops:<package.json version>` plus `:latest` with OCI `title` / `version` / `revision` /
  `created` labels so an image can be traced back to a commit. `--platform` switches to
  `docker buildx --load`, `--push` publishes each ref, `--dry-run` prints the command without needing
  a daemon, and unrecognized flags are passed through. Documented in
  [docs/deployment.md](docs/deployment.md#one-command) /
  [docs/deployment.zh.md](docs/deployment.zh.md#一条命令).
- **Medium-risk commands are held for a human decision instead of being only allowed or refused.** The
  command gate used to answer yes/no — `rm -rf /var/log/nginx` ran straight away while `rm -rf /` was
  rejected. It now classifies every command as `safe`, `confirm` or `blocked` and reports which rule
  matched. `confirm` is the new middle tier: the tool executes nothing, returns `NEEDS_CONFIRM` to the
  model and pushes a card into the chat carrying the rule code and the exact command, with *Run it* /
  *Do not run*. Clicking *Run it* trades the request for a single-use token (`ai-agent-confirm`) that
  the next turn carries back; the tool compares owner, chat, command text and execution scope before
  writing a byte, then burns the token. `blocked` (`rm -rf /`, `mkfs`, `dd of=/dev/sda`, writes to a
  raw device, `curl | bash`, fork bombs) never offers a card — those still have to be typed in a
  terminal by hand. **Boundary:** requests live in memory with a 5-minute TTL and die with the process,
  so a restart invalidates every outstanding card — intended, not a defect; the token is per command,
  per chat *and* per scope, so approving on one terminal never authorises the same command across
  `run_on_hosts` targets, and a token approved for two hosts is refused once the target list grows;
  cards are display state and are not restored after a page reload (the request still expires on its
  own); `sudo` prefixes are stripped before matching so `sudo rm -rf ...` cannot slip past; the gate reads
  command text and is not a sandbox (`bash -c "$(cat script)"` is outside what it can see); the legacy
  `safe` field keeps its old meaning for the batch panel (`confirm` counts as `safe` there, because a
  human clicking Execute *is* the confirmation), so `batch.service` needed no change. See
  [README.md](README.md#safety-rails) / [README.zh.md](README.zh.md#安全机制).
- **Skills load on demand: a catalog in the system prompt, the full text only when asked for.** A skill
  used to reach the model one way only — a human picked it and the whole Markdown went into that run's
  prompt — so the model could not choose a runbook and every selected skill cost its full length in
  context. Every run now starts with a catalog: one line per skill (`id — name: one-line purpose`),
  built by `SkillService.listSkills()` from what the account can actually see. When a task matches an
  entry the model calls the new `load_skill` tool and receives that skill's body; a manually selected
  skill is still injected in full *and* the catalog is still there, so an explicit pick and a
  self-loaded runbook can be combined in the same turn. A skill written without `description` derives
  its one-line purpose from the first heading of its body — no migration for skills that predate the
  field — and a purpose longer than 200 characters is clipped instead of turning the catalog back into
  prose. **Boundary:** `load_skill` resolves id first, then name, and refuses to guess on a miss — it
  returns `SKILL_NOT_FOUND` with the ids that do exist; one call is capped at 20k characters and the
  truncation is announced in the result, so the model asks for the rest rather than inventing it;
  repeated loads inside one turn are served from a per-turn cache in the run context, which dies with
  the run; the tool only reads the caller's own skills, owner taken from the run context and never from
  arguments; with no skill service wired the catalog is omitted and the tool answers
  `SKILLS_UNAVAILABLE` instead of pretending the library is empty. Prompt growth is now one line per
  skill: going from 3 to 10 skills adds seven lines, not seven documents (asserted in
  `scripts/verify-p3-skills.mjs`). See [README.md](README.md#skills) /
  [README.zh.md](README.zh.md#skills-技能).
- **Failure fingerprints: the same error on the same host is one row, not N audit lines.** `audit_events`
  records every tool call as a separate row and prunes it after 30 days, which answers "what did this
  command return" but never "is this an old problem, how many times has it happened, and when did it
  start". Migration `0009` adds `error_fingerprints`, keyed on owner + connection + fingerprint: the
  first occurrence inserts a row, every later one increments `occurrences` and moves `last_seen` while
  `first_seen` stays put, and `sample_text` / `command` follow the latest occurrence so the row always
  describes the most recent report. The fingerprint is `sha256(normalized representative line)[:16]`,
  produced by a single pure module, `server/utils/fingerprint.ts`, that folds timestamps (ISO, syslog,
  bare time), UUIDs, long hex and `0x` literals, PIDs, line/column numbers and the digits inside paths,
  lowercases the result and hashes the first 200 characters. Only one line is hashed — the first that
  matches a failure signature — so a run of `tail` output cannot split one error across many rows. This
  stage is **write-only**: there is no endpoint, no panel and no tool, and rows are pruned after 30 days
  by `last_seen` at startup and every six hours. **Boundary:** the audit hook's own `status: 'error'`
  was not a usable trigger — the engine's soft-failure detector only matches a few prefixes, so
  `bash: foo: command not found` is recorded as `success` — hence a second `after_tool` hook that
  decides for itself: the engine's `isError` flag *or* a deliberately narrow failure-signature list
  (`: command not found`, `No such file or directory`, `Permission denied`, `[emerg]` / `[error]`,
  `fatal:`, `Traceback`, `npm ERR!`, `docker: Error response from daemon`, `Connection refused`, …).
  Control-flow replies (`NEEDS_CONFIRM`, `BLOCKED`, `PERMISSION_DENIED`, `NO_LIVE_SESSION`,
  `Invalid arguments`) are never recorded, because a policy refusal is not a host failure; a bare
  `ERROR` inside grep output is not either. Only `execute_command` is aggregated — `run_on_hosts`
  returns one blob for N hosts while the hook carries a single session, so recording it would blame the
  wrong machine — and a run whose session is already gone has no connection to attribute to, so the
  write is skipped rather than guessed. Fingerprinting never blocks anything: a database error is
  logged and the command result is untouched (asserted in `scripts/verify-p4-fingerprints.mjs`). The
  same module will back P5's alert de-duplication, so the two phases cannot drift into two different
  keys. Documented under *Storage layout* in
  [docs/configuration.md](docs/configuration.md#storage-layout) /
  [docs/configuration.zh.md](docs/configuration.zh.md#存储布局).
- **Alerts leave the page: an error is now a stateful entity you can acknowledge, resolve and silence.**
  A log-monitor rule hit used to be a line in a 200-entry in-memory buffer that vanished on reload and
  could not reach anyone who was not looking at the panel. Migration `0010` adds `alerts` — one row per
  owner / connection / fingerprint carrying `level`, `message`, `first_seen`, `last_seen`, `occurrences`
  and a state of `open` / `acked` / `resolved` — plus `alert_mutes` for rule-level silence windows. The
  chat panel gains a fourth tab listing them with the occurrence count, the rule that fired, the
  connection and the account that acknowledged it; *Acknowledge* and *Resolve* act on a row and *Mute*
  silences that rule for 30 m / 2 h / 24 h. De-duplication is a database fact rather than a read-then-write:
  `status = 'resolved'` would make a plain unique key reject the next occurrence, so a stored generated
  column `open_key` equals the fingerprint until the row is resolved and `NULL` afterwards, backed by
  `UNIQUE (owner_id, connection_id, open_key)`; a concurrent insert that hits `ER_DUP_ENTRY` falls back
  to the update path instead of failing. A repeat hit only bumps `occurrences` and `last_seen`, never
  undoes an acknowledgement; an escalation (`warning` → `error` → `critical`) reopens the row, clears
  `acked_by` / `acked_at` and pages again, and a hit after *Resolve* starts a fresh row. Pushes go to
  `alerts.webhookUrl` with `X-AetherOps-Event` (`created` / `escalated`), an `X-AetherOps-Timestamp` and
  `X-AetherOps-Signature: sha256=<hmac-sha256(secret, "<timestamp>.<body>")>`, and only for new and
  escalated alerts — debounced per fingerprint for 5 minutes and retried after 30 s / 2 m / 10 m (three
  retries, four attempts), fire-and-forget so an unreachable receiver produces one log line and no
  blocked monitor. **Boundary:** only log-rule matches raise alerts (`source: 'log'`, `rule` being the
  monitor's pattern); command failures stay fingerprints until a later phase, so nothing here fires on
  `execute_command`; an alert belongs to owner + connection, not to a terminal session, and the three
  spellings of the local connection (`''`, `local`, `__local__`) are folded into `__local__` so one
  local error cannot split into three rows; silence suppresses delivery only, matching lines are still
  counted while muted; retention deletes resolved rows older than 30 days and never an `open` / `acked`
  one; pending retries live in the process, so a restart drops them while the rows themselves survive;
  the same `fingerprintLine` export that P4 introduced produces the key, and the endpoint keeps the
  monitor's permission bit. Asserted in `scripts/verify-p5-alerts.mjs` (100 hits on one line → one open
  row, `occurrences = 100`, one webhook). Documented under `alerts` in
  [docs/configuration.md](docs/configuration.md#alerts) /
  [docs/configuration.zh.md](docs/configuration.zh.md#alerts).

### Changed

- **The build stage's base image and Debian mirror are build arguments, so a blocked apt mirror no
  longer strands a build.** `BUILD_IMAGE` (default `node:22-slim`) and `DEBIAN_MIRROR` (default
  `mirrors.aliyun.com`) now exist as `ARG`s, and the toolchain layer installs python3/make/g++ only
  when the base image does not already have them — `--build-arg BUILD_IMAGE=node:22` skips the apt
  step entirely. **Boundary:** this is a build-time escape hatch, not a runtime setting (the server
  reads neither value); with no arguments the build pulls the same base and mirrors as before, so a
  rebuild produces the same image; the skip is decided by probing the base image, so a slim image
  that happens to carry the toolchain also skips the install.

- **The login session lifetime is a configuration value, not a constant.** `auth.tokenTtlSeconds`
  (default `7200`) drives the issued token's TTL and the renewal threshold —
  `max(30, min(1000, ttl / 4))` — and `AETHEROPS_AUTH_TOKEN_TTL_SECONDS` overrides it at the
  environment layer; startup validation rejects anything below 60 s, because with a threshold of 15 s
  no poll interval can renew a token before it lapses. The default is unchanged, so an existing
  deployment issues exactly the tokens it issued before. **Boundary:** raising the TTL lengthens one
  browser's session, not a screen's — a session is still single-issue per account, so the wallboard
  stays the job of a read-only token (previous entry); the renewal threshold stops growing at 1000 s,
  so a long TTL is refreshed when 1000 s remain rather than at a quarter of its length; the lifetime
  and the threshold are both derived from that one key at issue and renewal time, so there is no
  second constant to keep in step (the config layer still caches the file after the first load, so a
  changed value takes effect on the next process start or config reload). Documented in
  [docs/configuration.md](docs/configuration.md#auth) /
  [docs/configuration.zh.md](docs/configuration.zh.md#auth).
- **A tab left in the background polls the server-status panel every 60 s instead of every 2 s.** The
  panel keeps its 2 s cadence while visible; when `document.hidden` is set the timer switches to 60 s
  and a return to the foreground refreshes immediately, so a tab parked behind the wallboard stops
  being a 2-second request stream. It still polls — that is the point: each poll is an authenticated
  request, so a background tab keeps its session renewing instead of dropping the user on a login
  screen the moment they come back. The wallboard page applies the same rule with its own numbers
  (30 s visible, 120 s hidden), and its token does not renew at all, so there the slower cadence only
  saves load. **Boundary:** 60 s is well inside the renewal threshold of any sane TTL (1000 s at the
  default, 30 s at the 60 s minimum), so a hidden tab renews as before; with `auth.tokenTtlSeconds`
  at its floor a hidden tab can still miss a renewal and be logged out — that configuration is asking
  for short sessions. Documented in [docs/configuration.md](docs/configuration.md#auth).
- **`.dockerignore` tightened** to also exclude `packages`, `docs`, `.github`, `*.vsix`, `dist.rootbak`
  and `temp/`. The `Dockerfile` uses `COPY . .`, so anything left out of this file is shipped into
  the build context: the first time it is just slow, the second time it is wrong, because stale local
  build output gets mixed into an image whose dependencies were installed with `--frozen-lockfile`.
- **The verification suites left `temp/` and became a gate.** Seven scripts asserted P1–P6 — the
  agent's reach, approval tiers, skills, fingerprints, alerts and collaboration — but they lived in
  `temp/`, which `.gitignore` excludes: the only record of them was a note in this file, and they ran
  only when somebody remembered to type the path. They now live in `scripts/verify-*.mjs` beside
  `verify-auth.mjs`, behind one entry point: `scripts/verify-all.mjs` (`pnpm verify`; `--offline` for
  the three suites that need no database; `--list`; or a named subset such as `pnpm verify p5-alerts`)
  runs the migrations once, spawns each suite as its own process, prints a summary table and exits
  non-zero if any suite failed. A new reusable workflow, `.github/workflows/verify.yml`, runs the docs
  check, both type checks and the seven suites against a throwaway `mysql:8.0` service; `build.yml`
  (desktop artifacts) and `build-vsix.yml` (VSIX + Marketplace / Open VSX) each call it and `needs:`
  it, so a red suite now means no package is produced — until now the release path only installed
  and built. The same workflow runs `scripts/verify-docs.mjs`, which turns the `docs/` pairing rule
  into assertions instead of review attention: every `foo.md` has a `foo.zh.md`, the language switch
  line points at its twin, the h1–h4 structure matches heading for heading, both README tables list
  every document, the *Known limitations* / *已知边界* sections carry the same number of items, links
  resolve and code fences pair up. **Boundary:** the suites assert the *compiled* server
  (`dist/server/**`), so `pnpm build-server` comes first, exactly as in CI; four of them need a real
  MySQL and the offline subset is precisely the three in-memory ones, which makes
  `pnpm verify:offline` a fast pre-commit check rather than a substitute for the full run; the
  assertions are behavioural fixtures, not coverage — a phase that changes shape needs its fixture
  changed too, and green proves the recorded behaviours still hold, nothing more; the docs check
  proves structure and links, never that two prose paragraphs say the same thing. See
  [CONTRIBUTING.md](CONTRIBUTING.md#test-scripts).
- **The version line is this project's own from here on.** `package.json` read `1.0.26`, inherited with
  the fork and never bumped, so installers, the `latest.yml` the updater compares against and the Docker
  image tag all carried a number that no tag ever mentioned. It now reads `0.1.0` — the same number the tag
  says — so release label, installer file names, update manifest and in-app version finally agree. The
  number is plain `major.minor.patch`, no `-beta` suffix: `electron/updater.js` splits on `.` and calls
  `Number()`, so a suffix becomes `NaN` and the update check reports "already up to date" forever.
  **Boundary:** the number goes *down* — semver puts `0.1.0` below `1.0.26`, so the update check will not
  offer this build to anyone running 1.0.26; they download it once by hand. `packages/vscode` deliberately
  keeps its own line (`0.1.25`): the VSIX version has to equal whatever follows `aetherops-v` in the tag,
  and it ships on a different cadence from the app.
- **The upstream MIT notice is archived outside the extension package.** Upstream declares MIT in its
  README, but the only full copy of the text lives at `packages/vscode/LICENSE` — a path that a future
  VSIX rewrite would carry away with it. The same text now also sits at `LICENSES/AICmd-MIT.txt`, and
  both READMEs point there. Housekeeping, not a relicence: the notice still travels with every build,
  which is the single obligation MIT imposes.
- **The root `LICENSE` is plain MIT text again, so GitHub reports MIT instead of `Other`.** Explaining the
  lineage in the middle of the file — a paragraph between the copyright block and *Permission is hereby
  granted* — made GitHub's licence detection answer `NOASSERTION`: the sidebar printed `Other`, and the
  repository dropped out of `license:mit` searches, which reads as "terms unclear" to a stranger deciding
  whether to use the software. The explanation moved to [LICENSES/README.md](LICENSES/README.md); both
  copyright lines (this project and upstream `fefeding`) stay inside the copyright block of `LICENSE`,
  where detector tolerance exists and where the MIT obligation is actually discharged. Nothing about the
  terms changed — only where the prose about them lives.

### Fixed

- **A host with an open terminal stopped being sampled, and its wallboard card stayed grey, because another
  instance kept deleting its `sessions` row.** `cleanupZombieSessions()` ran every 30 s over *every* row of
  `sessions` and deleted the ones with no handle in this process — correct only while the table belongs to one
  instance. Two AetherOps sharing one MySQL (here a second server on another machine, visible as a different
  client IP) delete each other's live rows: each one's "zombie" is the other's open terminal. The next
  `loadSessionsFromDb()` cleared `sessionMetadata` and refilled it from a now-empty table, and everything
  downstream reads that map — `HostMetricsService.collectOnce()` walks `ssh.getSessions()`, so with no metadata
  there was nothing to collect, and with `metrics.offlineSampling` off `collectOffline()` returns on its first
  line: the round ended without a success line *or* a failure line, and the card read `-` for as long as the
  terminal stayed open. `loadSessionsFromDb()` now **merges** instead of overwriting — a row that vanished while
  this process still holds the handle is restored from memory — and the periodic sweep only touches ids this
  process created (`createdSessionIds`), so one instance can no longer delete another's rows. Two diagnostics
  came with it: `AETHEROPS_TRACE_SESSION_DELETE=1` prints the stack of every `deleteSessionMeta` call, and
  "metadata empty but N live handles" logs once per 5 minutes. **Boundary:** the table is still shared and
  last-writer-wins for name / system context; a row deleted while this process holds no handle for it is still
  lost, and a restart rebuilds purely from the table, as before; an instance older than this build keeps
  deleting — the merge makes this process tolerate that, it does not stop the other one, which has to be
  upgraded or stopped; rows left behind by a crashed run are no longer swept by the periodic timer (this process
  never created them), so they wait for the tab that restores them or for an explicit delete. Verified against
  the live deployment: with a probe holding one session open and the deletion still arriving every 30 s from
  the other host, `sessions` fell to 0 rows while minute buckets kept being written — `cpu` null on the first
  round (no previous sample to diff against), then 10.46, 22.65, 18.01 on the next three, where before the fix
  the same probe wrote one bucket and stopped. The `AFTER DELETE` trigger used to attribute the deletion (by
  `CONNECTION_ID()` and client IP) and its audit table were dropped afterwards.
- **Every host card on the wallboard was grey with `-` for CPU, memory and disk, even where history existed.**
  Two layers were wrong at once, and only the first one is a bug. `HostMetricsService.listHosts()` returned
  `latest: null` unconditionally — a placeholder that looked like "no data yet" but meant the board could
  never show a reading — and the repository behind it selected only `MAX(bucket)` and `SUM(samples)`, so the
  page had nothing to read even when the last minute bucket held values. `listMetricHosts` now groups per
  connection and joins `host_metrics_minute` back on that last bucket to return its whole row, mapped through
  the same `toMinuteMetricRow` as the time-series query (one mapping, so `DECIMAL` strings become numbers in
  one place), and `listHosts()` runs it through `toPoints`, so the board and `query_metrics` cannot drift.
  The second layer is not a bug and is now stated instead of implied: with `metrics.offlineSampling` off (the
  default) a host is sampled only while a terminal is open to it, so a card with no sample is the normal state
  of a mostly idle estate. `/api/watch/overview` therefore carries `sampling: { offlineSampling }`, and the host
  panel adds up to three one-line notes below the cards — only hosts with a session are sampled (turn the switch
  on to cover the rest), N connections are set to `sampling: 'skip'`, and CPU stays blank for one round because
  it is derived from two consecutive samples. **Boundary:** the four cards of a host with no sample still read
  `-` and stay dimmed after 10 minutes; the fix makes an existing sample visible, it does not create one — a
  host that has never been sampled needs a terminal or the opt-in switch; the connection list still decides
  which cards exist, so a host with samples but no saved connection shows in `hosts` and not on the board;
  `sampling` is optional in the client type, so a board left open against an older server shows the cards
  without the notes. Asserted end to end on a scratch port: a synthetic minute bucket for a throwaway account
  comes back through `/api/watch/overview` with `cpuAvg` / `memAvg` / `diskAvg`, `lastAt` equal to the bucket,
  and a non-stale card (10/10 checks); the scratch rows, connection, token and account were removed afterwards.
- **A refresh threw away every terminal tab together with its scrollback; the workspace now lives in
  `sessionStorage`.** The tab bar was rebuilt from the server's `sessions` table, which preserved the
  wrong thing: closing the browser and opening it again brought the tabs back — empty, because the
  table only ever held metadata — while an ordinary F5 could leave nothing to rebuild from at all
  (a reconnect that failed, a server restart, an already-pruned table), and what the terminal had
  printed was gone in every case. The workspace now belongs to the browser tab: `aetherops.workspace.v1`
  holds the tab list and the active tab, `aetherops.termbuf.v1.<tabId>` holds the last ~120 000
  characters that terminal received — flushed on a 1.5 s timer and once more on `pagehide`, replayed
  into a fresh xterm before the new session connects, with a divider line marking where the replay
  ends. `sessionStorage` is dropped when the tab or the browser closes, which is the requested
  lifetime; signing out clears it as well, so the next account does not inherit the previous one's
  terminals. Restored tabs also ask the server not to run its startup `cls` (`clearScreen: false`,
  honoured by `createLocalSession`) — that clear landed right after the replay and erased it. That alone
  was not enough: on Windows `pwsh` clears the screen by itself as it starts, so the history disappeared
  again the moment the new session began. A restored tab therefore holds the new session's startup output
  until the banner has finished (first `ESC[2J`/`ESC[3J` plus a 400 ms grace, so the server's `chcp` /
  `cls` tail is caught too, and a 1.5 s ceiling), strips the erase-display
  and cursor-home sequences out of the held frames (`src/utils/terminal-restore.ts`), and only then writes
  history → divider → startup output, so the screen ends up as "everything from before, and the new shell
  continuing below it" rather than a cleared viewport.
  **Boundary:** the shell process still ends when the WebSocket closes — the text above the divider is
  a replay, not a reattached PTY, so a command that was still running is gone; a local server shell
  asks for its password again after a refresh, because that secret is deliberately never written to
  disk; frames the server marks as binary are replayed only when they decode as text (Chinese output
  travels that way), and ZMODEM frames are skipped, since replaying a transfer into xterm only paints
  garbage; `sessionStorage` quotas are handled by dropping buffers, never the tab list.
  Verified by `vue-tsc`, `vite build`, a Node harness over the real snapshot module (15 checks: round
  trip, malformed JSON, 12-tab cap, tail trimmed from a whole line, quota fallback, cleanup) and a
  WebSocket-level run against a real `pwsh` on a scratch port (8 checks: `clearScreen: false` drops the
  `cls` echo, the banner does carry its own `ESC[2J`, the filter removes exactly that and keeps the
  text). Not exercised end to end in a browser — no automation was available in this environment, so
  the F5 round trip itself is untested by machine.
- **The AI chat's stop button did not stop anything the UI could see.** Clicking it aborted the run on
  the server, but the abort path returned without emitting a terminal event — and the "already produced
  output → give up" check ran first, while an abort mid-stream always has produced output — so the
  client received nothing and stayed on "Generating…" with the input box disabled for good. The run now
  emits a `stopped` event before either return, the abort is no longer recorded as a provider failure
  (a user pressing stop must not lower a model's measured health), and the abort controller is deleted
  only if it is still the current one, so a provider that closes late cannot remove the next turn's
  stop handle.
- **`pnpm build` stopped after Vite finished, so the server bundle was never compiled.**
  `vite.config.ts` imports `server/index` at module scope, because the dev server must reuse the same
  service singletons; importing it constructs `MonitorService`, whose 5 s analysis `setInterval` was
  created without `unref()`. The event loop therefore never drained: `vite build` printed the asset list
  and stayed alive, the `&&` chain in `build-only` ended there, and `tsc -p tsconfig.server.json` never
  ran — `dist/public` looked fresh while `dist/server` silently kept whatever an older build had left.
  Anything that runs `pnpm build` inherited the hang, including the Docker image build and CI. The timer
  is now `unref()`d, matching how `SSHService` has guarded its periodic cleanup timer.
- **Restarting the dev server no longer leaks MySQL connections.** Editing `vite.config.ts` — or any
  module it imports — makes Vite re-evaluate the whole config module graph *inside the same process*.
  `db/pool.ts` kept its pool in a module-scope variable, so the second evaluation saw `null`, opened a
  second pool, and nothing ever `end()`ed the first: one extra connection per restart, permanently,
  because `mysql2` only schedules its idle reaper when `maxIdle < connectionLimit` and both defaulted to
  the same value. The target instance allows 50 connections and is shared, so a morning of restarts
  exhausted it and every other client — including a running `server.js` — failed with
  `Too many connections`. The pool, the Redis client and the service graph are now held on `globalThis`
  under `Symbol.for(...)` keys, so a re-evaluated module reuses the live instance instead of building a
  second one; `initServices()` caches its promise (no duplicated metrics timer) and clears it on failure
  so a host that starts before MySQL can retry; and the pool finally sets `maxIdle` below
  `connectionLimit` with a 60 s `idleTimeout`, so connections a burst opened are released again.
  **Boundary:** measured on the dev server — five restarts, connection count stayed at 1, where a single
  restart used to make it 2. The same `maxIdle` / `idleTimeout` pair also bounds idle connections in a
  long-running process, but it cannot help a process that was killed and replaced: the old instance has
  to be gone before the new one is useful.

### Security

- **Passwords no longer cross the network as plaintext.** Login, self-service registration, self-service
  password change, admin account creation, admin password reset and the "default server shell" gate now
  carry their password fields as an AES-256-GCM envelope
  (`ao1.<base64url(iv)>.<base64url(ciphertext||tag)>`, key derived from a fixed passphrase, a fresh IV per
  message, and a 10-minute freshness window so a captured packet cannot be replayed), and passwords the
  server generates are sealed on the way back as well. The server **rejects plaintext** on those fields
  with `400 cipher_required` — there is no readable fallback. The envelope exists because the common
  deployment is plain HTTP on a LAN with no reverse proxy; the key necessarily ships in the client bundle,
  so it defends against plaintext on the wire (capture, proxy logs, middleboxes) and TLS in front remains
  the stronger control. See `server/utils/transport-crypto.ts`, `src/utils/transport-crypto.ts` and
  [docs/accounts-and-permissions.md](docs/accounts-and-permissions.md#transport-encryption).

Add entries under `Added` / `Changed` / `Fixed` / `Removed` / `Security` as part of the pull request
that makes the change, not afterwards.

## 1.0.26 — 2026-11-02

The state of the fork at the time it was prepared for open-source publication. `1.0.26` was the version
inherited from upstream and never bumped; it was never tagged and no artifacts exist for it, and the
number was replaced by this project's own line in `v0.1.0`. Grouped by theme, because the
underlying history was written as a handful of large feature commits rather than release increments.

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

- No per-account UI or API for creating skills; the table and service layer exist, the write path does not
  (added later — see the *Per-account skills* entry under Unreleased).
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
