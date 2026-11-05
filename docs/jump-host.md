# Jump Hosts and SSH Agent Forwarding

**English** · [简体中文](./jump-host.zh.md)

AetherOps reaches internal hosts by logging in to a bastion and letting a **startup script** perform
the second hop. There is no dedicated "jump host" field: a connection is treated as a bastion purely
because it has a startup script configured.

```
browser / desktop ──SSH──▶ bastion ──SSH──▶ target host
                              │
                    startup script writes the
                    second-hop command into the shell
```

- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Agent forwarding](#agent-forwarding)
- [Setting up your ssh-agent](#setting-up-your-ssh-agent)
- [System information on the target host](#system-information-on-the-target-host)
- [Multi-hop chains](#multi-hop-chains)
- [Troubleshooting](#troubleshooting)
- [Security recommendations](#security-recommendations)

## How it works

1. AetherOps connects to the bastion with ssh2 and opens an interactive shell channel.
2. **800 ms** after the channel is ready, the trimmed startup script is written to the shell as if you
   had typed it, followed by a newline.
3. The bastion executes it — normally an `ssh` command — and the terminal now shows the target host's
   shell.
4. Everything downstream (terminal input, the AI agent, command auditing) operates on whatever shell is
   currently in front of it, which after a successful hop is the target's.

Consequences of implementing the hop as "type a command into a shell":

- The hop is **not atomic and not verified**. If `ssh` fails (key rejected, host unknown, timeout),
  the shell stays on the bastion and the terminal just shows the error text. Nothing detects "the hop
  did not happen".
- Because the first hop is a real interactive session, the second hop inherits whatever the bastion
  allows — you still need valid credentials for the target *as seen from the bastion*.
- Timing is a heuristic. A slow link or a long MOTD can outrun the 800 ms delay.

## Configuration

In the connection editor:

| Field | Value |
|-------|-------|
| Name | Something that says both ends, e.g. `bastion → prod-db-01` |
| Host / Port / Username | The **bastion** — never the target |
| Authentication | Key, password or automatic, for the bastion |
| Startup script | The command that reaches the target |
| SSH Agent forwarding | Tick it if the second hop should use your key |

Startup script examples:

```bash
ssh ubuntu@192.168.1.100
```

```bash
ssh -p 2222 admin@target-server.internal
```

```bash
sleep 1; ssh -J jump2.internal target.internal
```

Keep it **one line**: it is written as a single string into the shell. If the bastion prints a long
MOTD, prepend `sleep 1` (the built-in delay is 800 ms and is not configurable per connection).

## Agent forwarding

Enabling the checkbox does two things on the server side:

1. At connect time, `config.agent` is set to a detected agent socket — `$SSH_AUTH_SOCK` on
   Linux/macOS, or the fixed OpenSSH pipe `\\.\pipe\openssh-ssh-agent` on Windows.
2. The shell channel is opened with `agentForward: true`, so the target (and the bastion) can reach
   that agent through the forwarded socket.

This means **no private key is stored on the bastion** — signing happens against the agent socket.

**Which machine's agent?** The one running the **AetherOps backend**, since that process is the SSH
client. This distinction matters:

| Host | Whose agent is forwarded |
|------|--------------------------|
| Electron desktop, VS Code extension | Yours — the backend runs on your machine, so your local agent is used |
| Shared web deployment | The **server's** agent, not the browser user's. Your laptop's keys are not reachable |

For a shared web instance, agent forwarding is therefore an operator-level feature: either the server
host has an agent with keys that the bastion trusts, or the second hop must authenticate some other way
(target key stored in the connection, password, or bastion-side keys). There is no way to delegate a
browser user's local agent into a remote backend.

If no agent is found, the connection log says so and forwarding is silently skipped:

```
Agent forwarding 已请求但未检测到 SSH agent
No SSH agent detected. Agent forwarding will not work.
```

Enabling `debug.sshDebug` (or `AETHEROPS_SSH_DEBUG=1`) puts the ssh2 protocol trace into the terminal,
which is the fastest way to see whether an `auth agent` request was ever made.

## Setting up your ssh-agent

### Linux / macOS

```bash
echo $SSH_AUTH_SOCK          # non-empty → an agent is running
ssh-add ~/.ssh/id_rsa
ssh-add -l                   # list loaded keys
```

If none is running:

```bash
eval $(ssh-agent -s)
ssh-add ~/.ssh/id_rsa
```

macOS, to survive reboots via the Keychain:

```bash
ssh-add --apple-use-keychain ~/.ssh/id_rsa
```

### Windows

The OpenSSH agent service is **disabled** by default. In an elevated PowerShell:

```powershell
Start-Service ssh-agent
Set-Service ssh-agent -StartupType Automatic
ssh-add $HOME\.ssh\id_rsa
ssh-add -l
```

If the capability is missing:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

Note that the pipe path ssh2 uses is the one the Windows OpenSSH agent creates. A third-party agent
(PuTTY's pageant, for example) does not expose that pipe, so forwarding will not find it.

## System information on the target host

For ordinary SSH sessions, AetherOps derives environment info from the login **MOTD** (captured for 3 s
in the background), falling back to an active probe over a separate `exec` channel when nothing usable
arrives.

For a session with a startup script, the cached/captured data would describe the *bastion*, so the
behavior differs deliberately:

- The connection is identified as a bastion session by having a non-empty startup script.
- Cached context is **ignored** and re-collected every time.
- Collection waits until the session is at least **8 s old**, so the second hop has had time to
  complete (script at 800 ms + a 2–5 s hop).
- The bastion hop cannot use the `exec` channel — that would run on the bastion — so the probe is
  **typed into the interactive terminal** and its echo is read back, with prompt lines stripped from
  the captured text.
- The OS family is probed first, then the matching collection script is sent. Before family detection
  existed, a bash-only probe on a Windows target produced nothing but unreadable error echo.
- Timeouts: family probe 8 s, collection script 15 s (output must go idle for 1.5 s to be considered
  complete).

What this means in practice:

- Asking the AI "what's on this server" on a fresh bastion session may take several seconds before it
  answers — it is waiting for the settle window.
- The **server status panel** describes where its probe runs, which for a bastion session is the
  bastion. The panel and the AI context do not necessarily agree about which machine you are on; the
  AI's collected context is the one that follows the hop.
- Injecting a probe into an interactive shell is visible in the terminal. If you are running a
  full-screen program (an editor, `top`), that injection will garble it — collect context before or
  after, not during.
- If the hop has not finished when collection runs, the reported environment is the bastion's. Increase
  the reliability by making the startup script slower to fail rather than faster (e.g. `ssh -o
  ConnectTimeout=10`), or open the chat a few seconds after connecting.

## Multi-hop chains

Chaining is just a startup script that hops more than once.

```bash
ssh -J jump2.internal target.internal
```

```bash
ssh jump2.internal -t 'ssh target.internal'
```

`-J` (ProxyJump) is preferred where the bastion supports it: fewer interactive shells, cleaner agent
handling. `-t … 'ssh …'` forces a pseudo-terminal on the intermediate hop, which is required when the
next hop needs a TTY.

Agent forwarding through a chain needs every hop to pass it along: the local agent is forwarded to
bastion 1, and bastion 2 must be reached *from* bastion 1 with forwarding still active. Intermediate
hosts must have `AllowAgentForwarding yes` (and not restricted by `Match` blocks) for the key to remain
usable at the far end.

## Troubleshooting

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| Second hop says `Permission denied (publickey)` | Agent forwarding not active | Was an agent socket found in the connection log? Is the key loaded (`ssh-add -l`)? On a shared web backend, is the *server's* agent the one with the key? |
| Script never runs, shell just sits on the bastion | MOTD too long / slow link outran the 800 ms write | Prefix `sleep 1;` |
| Hop works in your terminal, fails in AetherOps | Your interactive shell has `SSH_AUTH_SOCK` from a login session; the backend process does not | Start the backend from a shell where `echo $SSH_AUTH_SOCK` is non-empty, or use the Windows OpenSSH service |
| Environment info describes the bastion | The probe ran before the hop finished, or the hop failed | Look at the terminal: is the prompt from the target? Re-ask after a few seconds |
| Full-screen program breaks after connecting | The probe was typed into the interactive shell | Don't start `top`/editors within the first ~15 s of a bastion session |
| `ssh: Could not resolve hostname` on the second hop | The target name only resolves inside the target network — which is where you are, so this usually means the hop *did not* happen | Confirm the prompt changed; use an IP to rule out DNS |
| Password auth for the second hop | `sshpass` in the startup script | Works, but the password appears in the process list and in the terminal echo. Prefer keys |

Using `sshpass` (as in the older revision of this guide) is possible but discouraged:

```bash
sshpass -p 'password' ssh user@target-server
```

The credential is visible in the bastion's process list, in the terminal, and in command audit records.
It is a workaround for a missing key rollout, not an authentication strategy.

## Security recommendations

1. Forward an agent instead of copying private keys onto the bastion.
2. Keep bastion permissions narrow: SSH only, no extra services, and restrict which targets it may
   reach.
3. Rotate keys regularly — forwarding means the loaded agent key is usable on everything it can reach.
4. Remember that the AI agent operates on the **target** shell. A prompt-injection-style mistake in the
   audit trail is a command that actually ran; review `audit` records for bastion sessions like any
   other host ([accounts-and-permissions.md](./accounts-and-permissions.md#admin-oversight)).
5. Batch commands (`can_use_batch`) against a list of bastion connections fan out through the hop — the
   blast radius is the targets, not the bastions. Grant that bit accordingly.
