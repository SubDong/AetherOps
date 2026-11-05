# Skills: Reusable Playbooks for the Agent

**English** · [简体中文](./skills-guide.zh.md)

A skill is a Markdown playbook that gets injected into the agent's system prompt for one run. It tells
the model *how* to do a class of task on your infrastructure — steps, platform differences, safety
checks, output format — instead of letting it improvise every time.

```markdown
---
name: Docker Management
description: Docker container lifecycle management, cleanup, monitoring, and troubleshooting
tags: [ops, docker, containers]
---

Manage Docker containers, images, volumes, and networks efficiently. Use scripts for batch operations.
...
```

- [Where skills come from](#where-skills-come-from)
- [Current limits of the write path](#current-limits-of-the-write-path)
- [File format](#file-format)
- [How a skill is selected](#how-a-skill-is-selected)
- [What the agent actually receives](#what-the-agent-actually-receives)
- [Built-in skills](#built-in-skills)
- [Writing good skills](#writing-good-skills)
- [Full example](#full-example)
- [Debugging](#debugging)
- [Contributing skills](#contributing-skills)

## Where skills come from

| Source | Location | Scope | Loaded |
|--------|----------|-------|--------|
| **Built-in** | `<app root>/data/skills/*.md` | Everyone, read-only | Read once at startup (per process), from `process.cwd()/data/skills` |
| **User** | MySQL table `skills`, keyed by `owner_id` | One account | Queried on every list/get — never cached in the process |

Built-ins are files that ship with the code and move with git, so they are reviewable. User skills are
database rows, because a shared web instance cannot give every account write access to one directory.

Merging rule: for one account's view, a user skill **replaces** a built-in with the same id (the id is
the file name without `.md`; for a DB row it is the row's key). Two accounts never see each other's
user skills — the service deliberately does not cache a merged map, since one process serves everyone.

Note that `data/skills` is *not* under the data directory (`~/.aetherops`): the Docker image copies it
to `/app/data/skills` precisely because the lookup is relative to the working directory. A container
missing that step shows an empty skill list.

## Current limits of the write path

Being explicit here, because the upstream documentation promised more than the code does:

- `SkillService.saveUserSkill()` and `deleteUserSkill()` exist and work, and the `skills` table is
  ready, but **no HTTP endpoint and no UI calls them**. The registered routes are
  `/api/ai/getSkills` and `/api/ai/getSkill` only.
- Therefore, in practice today: authoring a skill means editing a file in `data/skills`, which requires
  filesystem access to wherever the backend runs, plus a restart. On a shared deployment that is an
  operator action, not a user feature.
- There is no reload endpoint either. Adding or editing a built-in file takes effect on the next
  restart (`skillService.reload()` is not wired to any route).

If you want per-account skill creation, that is a legitimate contribution: add owner-scoped routes, keep
them behind the `skills` permission bit, and reuse the existing repository functions rather than
inventing a second storage path.

## File format

A skill file is YAML-ish front matter plus Markdown. The parser is a small hand-rolled regex
(`skill.service.ts#parseSkillFile`), not a YAML library, so the supported shape is narrow:

```markdown
---
name: Nginx Management
description: Manage Nginx - config validation, reload, SSL, troubleshooting
tags: [ops, nginx, web, ssl]
---

正文：给 Agent 的具体指令 / instructions for the agent go here
```

| Field | Required | Effect |
|-------|----------|--------|
| `name` | no (falls back to the file id) | Shown in the skills panel and in the injected header |
| `description` | no | Shown in the panel; also used as the prompt text when you send a bare `/skill-id` |
| `tags` | no | Metadata only, surfaced in the list. **Nothing matches on tags automatically** |
| body | yes, practically | The instructions the agent follows |

Parser constraints that bite in practice:

- Front matter must start at **byte 0** of the file with `---`; anything else (a blank first line, a BOM
  before the delimiter) means "no front matter", and the whole file — delimiters included — becomes the
  body.
- Each field must be **one line** matching `^key:\s*value`. Multi-line YAML blocks, nested maps, lists in
  block form (`- item`), and comments are not understood; the value is taken verbatim to end of line.
- Quotes and brackets are stripped wherever they appear in the value, so `tags: ["ops", "nginx"]` and
  `tags: ops, nginx` both work, and `description: "He said "hi""` is not going to be clever.
- Only `name`, `description`, `tags` are read. Extra keys (`version`, `author`, `platform`) are ignored —
  fine to keep for humans, invisible to the loader.
- A file that cannot be read is logged (`[SkillService] Failed to parse skill: …`) and skipped; it does
  not stop startup, so a typo can silently remove one skill from the list.
- Encoding: UTF-8. Line endings CRLF or LF both parse (the regex accepts `\r?\n`).
- The id is the file name: `nginx-management.md` → `/nginx-management`. Spaces and non-ASCII in file names
  make slash commands awkward — use kebab-case.

There is no size limit enforced in code. Everything is injected verbatim on every turn of a run, so a
50 KB playbook is 50 KB off your context window; the built-ins stay under a few KB on purpose.

## How a skill is selected

Two paths, both explicit — the agent never picks a skill by itself:

1. **Skills panel** — open it in the chat area and click a skill; it stays selected (with a clear button)
   until you send, then resets.
2. **Slash command** — type `/` + the skill id. Matching is exact and case-insensitive against the id,
   and only when the message starts with `/`:

   | You type | What the agent receives |
   |----------|-------------------------|
   | `/docker-manage` | Instructions from that skill, with the skill's `description` as the task text |
   | `/docker-manage prune stopped containers` | Same instructions, task text = your words after the command |
   | `/docke` | No exact match → sent to the agent as an ordinary message |
   | `please /docker-manage now` | Not at position 0 → ordinary message |

There is **no** keyword/tag auto-matching and **no** "let the LLM choose the skill" step. Natural language
like "帮我看看 docker 状态" works only if the model happens to be in a context where that skill is
selected — the older revision of this guide claimed automatic tag matching, and the code has no such
path.

Access to the list is permission-gated: `/api/ai/getSkills` accepts either the `skills` bit or the `ai`
bit, since picking a skill is part of chatting.

## What the agent actually receives

When a run starts with a skill, the server appends to the system prompt:

```
## Current Task Instructions (Skill: <name>)

<entire skill body>
```

Details worth knowing:

- It is per **run**, not a persistent mode. The next message without a skill has no such section.
- It is an *addition* to the base system prompt (which already carries terminal context and tool
  definitions), not a replacement.
- The skill id and name are stored on the user message in chat history, so the transcript shows which
  playbook produced which answer, and "retry" on that message re-uses the same skill.
- Skills cannot grant capability. A skill that says "restart all services" only runs if the account's
  permission bits and the agent's own dangerous-command handling allow it. The blacklisted commands in
  the agent engine are not bypassed by playbook text.
- Prompt-injection surface: skill content is trusted input written into the system prompt. On a shared
  instance, whoever can write a skill can steer the agent's behavior for that account — which is why
  user skills are owner-scoped and why a future write endpoint belongs behind the `skills` bit.

## Built-in skills

The three playbooks shipped in `data/skills`:

| Id | name | Purpose |
|----|------|---------|
| `server-health-check` | Server Health Check | One-pass metric collection (CPU, memory, disk, network, processes, services) via a generated script that adapts to Linux / macOS / Windows |
| `log-analyze` | Log Analysis | Error-pattern detection, frequency counts, anomaly correlation across Nginx / application / system logs; uses scripts for throughput |
| `docker-manage` | Docker Management | Container lifecycle, image/volume cleanup, network troubleshooting, batch operations |

Read them as examples as much as features: each one demonstrates the pattern the agent handles best —
collect in one script rather than twenty round-trips, state platform differences explicitly, and end with
a defined output shape.

## Writing good skills

1. **Say how, not just what.** "Generate one bash script that collects all metrics in one pass" beats
   "check the server". Round trips against a remote shell are slow and noisy.
2. **Handle platform differences by name.**
   ```markdown
   - **Linux**: `systemctl` for services
   - **macOS**: `launchctl`; no `systemctl`
   - **Windows**: PowerShell cmdlets (`Get-Service`, `Stop-Service`); assume cmd may wrap the call
   ```
3. **Define when to script instead of running one command** — more than ~3 sequential steps, loops,
   conditionals, or large output.
4. **State safety rules the agent must not trade away.**
   ```markdown
   - ALWAYS run `nginx -t` before reload
   - Back up the config before a major change
   - Never `DROP DATABASE` without explicit confirmation in this turn
   ```
5. **Fix the output format** so results are comparable across runs: summary line, metrics table, flagged
   issues, recommendations.
6. **Assume nothing about the host being reachable as you are.** Prefer read-only discovery first
   (`command -v docker`, `nginx -v`) before any mutation, so a missing tool fails with a clear message
   instead of a chain of errors.
7. **Keep it short.** Every line competes with the terminal output you also want the model to read.

## Full example

```markdown
---
name: Nginx Management
description: Manage Nginx web server - config validation, reload, SSL, troubleshooting
tags: [ops, nginx, web, ssl]
---

Manage Nginx configuration and troubleshoot serving problems.

## Pre-check

Confirm Nginx is present before doing anything else:

    nginx -v 2>&1 || echo "Nginx not installed"

## Common operations

Config validation — ALWAYS before a reload:

    nginx -t

Graceful reload (no downtime):

    systemctl reload nginx    # Linux
    launchctl kickstart -k system/org.macports.nginx   # macOS, MacPorts

Inspect the active configuration:

    cat /etc/nginx/nginx.conf
    ls /etc/nginx/sites-enabled/   # Debian/Ubuntu layout
    ls /etc/nginx/conf.d/          # RHEL/CentOS layout

Certificate dates:

    echo | openssl s_client -connect localhost:443 -servername $(hostname) 2>/dev/null | openssl x509 -noout -dates

## Troubleshooting

502 Bad Gateway: check the upstream service status, then `tail -50 /var/log/nginx/error.log`,
then confirm the upstream port is listening (`ss -tlnp`).

High memory or CPU: `ps aux | grep nginx`, review `worker_connections`, check the open-file limit.

## Safety

- Never reload without `nginx -t` passing first.
- Copy the config to a `.bak` before structural changes.
- Test TLS changes with `curl -vk https://localhost` before declaring success.

## Output format

1. One-line summary of what was done
2. Table of checks and results
3. Remaining risks, flagged
```

## Debugging

| Question | How to answer |
|----------|---------------|
| Did my file load? | Startup log: `[SkillService] Loaded N system skills (user skills are per-account, queried on demand)`. N lower than expected → look for the `Failed to parse skill` line above it |
| Is the front matter parsed? | Panel shows the id instead of `name` → front matter not recognized (see [File format](#file-format) constraints) |
| Which skills does this account see? | `POST /api/ai/getSkills` with the account's bearer token — it returns exactly the merged view (built-ins + this owner's rows) |
| Was the skill injected into the prompt? | The turn's user message carries a skill badge in the transcript; the WS `ai-agent-run` frame carries `skillId` (DevTools → Messages) |
| Why did nothing happen on `/myskill`? | Id mismatch (slash matching is exact on the file name), or the `/` is not the first character |
| My edit did not appear | Built-ins are read at startup; restart the backend |

## Contributing skills

- Add a new built-in by dropping `data/skills/<kebab-case-id>.md` in a PR. It becomes available to every
  account on that deployment, so write it to be correct for strangers: no internal hostnames, no
  environment-specific assumptions, no credentials — see [CONTRIBUTING.md](../CONTRIBUTING.md).
- Prefer improving the existing three over adding a near-duplicate; the list is shown in full in the
  panel and long lists are painful to scan.
- Skills are documentation that the model executes. Review them with the same care as a shell script:
  a wrong "always do X first" instruction becomes a wrong command on real hosts.
