# Offline sampling FAQ

**English** · [简体中文](./offline-sampling-faq.zh.md)

Everything on this page is about one switch: `metrics.offlineSampling`. The per-minute collector can
reach a host two ways — through a terminal somebody already has open (always on), or by dialing the
saved connection itself (this switch, off by default). The four questions below are the ones that
come up before people turn it on, and each answer describes what the collector actually does rather
than what it is supposed to feel like.

- [Why the switch is off by default](#why-the-switch-is-off-by-default)
- [Jump-host connections: which machine is sampled](#jump-host-connections-which-machine-is-sampled)
- [Why a failing host is not retried every minute](#why-a-failing-host-is-not-retried-every-minute)
- [Using `sampling: 'skip'`](#using-sampling-skip)

## Why the switch is off by default

Because turning it on changes what the product does to machines nobody is watching.

With the switch off, the collector only reads hosts that already have a session. It opens one extra
`exec` channel on the connection you are using; it never originates a login. That is also why a host
you connected to for three minutes has exactly three minutes of history, and why an idle host has a
gap rather than a row of zeros.

With it on, a host with no session gets a **fresh TCP connection and a full SSH login every minute**.
On the target that is an entry in `sshd`'s authentication log, once a minute, forever — and it keeps
appearing at 03:00 while everyone is asleep. That is a visible change in the target's audit trail,
often the only record of who logged in and when. It is not something an upgrade should decide on
your behalf: an operator who expects "this thing only connects when I open a terminal" is right to be
surprised by a login they never asked for. So the default is off, the switch is documented where the
other config keys are, and enabling it is a deploy-time decision.

Turn it on in `~/.aetherops/config.json` (mode `0600`, in the data directory):

```json
{
  "metrics": {
    "offlineSampling": true
  }
}
```

Or export `AETHEROPS_METRICS_OFFLINE_SAMPLING=1`; the environment wins over the file. Values are read
once when the process starts (`loadConfig` caches the merged result), so **a restart is required** —
editing the file under a running server changes nothing. `AETHEROPS_METRICS_OFFLINE_SAMPLING` is a
small-range rollout knob: put it in the unit file for one instance, leave the rest alone.

What it costs per host per minute: one handshake (capped at 12 s), 2 to 4 `exec` commands sharing
that one connection, and one row in `host_metrics_minute`. At most 2 hosts run in parallel and a
round stops taking new work after 45 s, so enabling it on 50 connections does not mean 50 logins at
once — see the third question.

What counts as a candidate each minute — every connection in every account, minus:

- `__local__`, the virtual connection with no config row: there is nothing to dial, its history can
  only come from a local shell somebody actually opened;
- connections whose `sampling` is `skip` (fourth question);
- hosts that have a live session right now — they are already sampled through it, and taking both
  paths would double both the sample count and the logins;
- hosts already written in this minute, or still inside a backoff window, or whose first-sample phase
  has not arrived yet.

`local` type connections stay in the list but are read through Node's `os` / `statfs` — no dial, no
login, no shell password gate — so they are sampled whenever a round reaches them.

## Jump-host connections: which machine is sampled

`connection.host` — the machine AetherOps actually logs into, which for a jump-host connection is the
bastion itself. Not the machine the startup script would hop to.

The reason is structural rather than a shortcut: `startupScript` is a line of text written into an
**interactive** shell about 800 ms after the PTY opens. The one-shot channel has no PTY and no
interactive shell, so the script is deliberately not replayed there. Running a hop on top of that
channel would either do nothing or leave the collection reading whatever the hop printed — and either
way the sample would be pretending to describe a machine it never touched. So the one-shot channel
samples exactly what `host` resolves to.

This matches the other two features that already behave this way: the status panel probes over the
direct SSH channel, and the file manager browses the same channel — both describe the bastion. Live
terminal sessions on such a connection also collect from the bastion (`execReadonly` lands on the
same direct channel), which is precisely why history from the two paths agrees: same machine, same
numbers, no seam between "before your terminal opened" and "after".

If you need per-target history, do not try to make the collector follow the hop — create one
connection per target using a real `-J` / `ProxyJump` style setup. That connection genuinely
terminates on the target, so the panel, the file manager, the metrics history and the AI's
environment context all describe the same machine. The startup-script hop exists to give you an
interactive shell on the target; it was never the mechanism behind history.

## Why a failing host is not retried every minute

Because a login that fails once a minute is exactly what `fail2ban` blocks — and the ban takes down
the terminals other people have open, not just the missing samples. A backoff is cheaper than an
incident.

Limits apply in this order:

| Limit | Value | What it prevents |
|-------|-------|------------------|
| First-sample phase | hash of `owner:connection` → 0–59.999 s | every host logging in at the same second right after the switch is flipped |
| Per-minute dedupe | one write per owner / connection / minute | two samples in one bucket |
| Concurrency | 2 workers | 50 hosts handshaking at once |
| Round budget | 45 s, then the round stops taking work | a round spilling into the next one |
| Rotation cursor | hosts cut off by the budget go first next round | a candidate list longer than one round starving its tail |
| Handshake cap | 12 s (`readyTimeout`), plus a 3 s hard stop | one dead host eating the whole round |
| Backoff, ordinary | 1 → 2 → 4 → 8 → 15 min, then 15 | a host that is down being knocked on every minute |
| Backoff, authentication | 30 → 30 → 60 min, then 60 | `fail2ban` shutting the IP out |
| Log throttle | one warning per connection per 10 min | a wrong password filling `server.log` |

"Authentication" is matched on the error text (`authentication`, `permission denied`, `no supported
authentication`) and gets its own ladder because it is the one failure mode with a blast radius
beyond the missing samples: the same IP serves everyone else's terminals.

What counts as a failure: the handshake errors or times out; the OS family cannot be identified
(`unknown`); or the probe ran but nothing parsed — a host that answers with a shell that does not
understand the script, or an account that cannot read system information, is a failure rather than a
row of zeros. Nothing is written in that case, so `query_metrics` reports a gap for that window
instead of averaging a fake zero into the day.

Recovery is immediate: on the first success the failure count and the retry deadline are both
cleared, so a host that comes back is sampled once a minute again with no ramp-up. A sample that
arrives after a long gap is also not diffed against a stale baseline — the previous sample is kept
for 5 minutes only, so after an outage the CPU percentage for that minute is stored as `NULL` on the
cumulative families (Linux, macOS, HarmonyOS) instead of being averaged across the whole gap. Windows
reports an instantaneous figure, so there it is stored as-is.

The retry state lives in memory: a server restart clears every backoff, and the first round after a
restart is spread out by the phase table above. That is deliberate — a restart is usually also a
config change, and the new config deserves one honest attempt per host.

## Using `sampling: 'skip'`

The switch is global. `skip` is the per-connection exception, and it exists because the hosts you
least want logged into unattended — production databases, customer environments, machines with an
audit requirement — are exactly the ones that sit in your connection list. Without it the only
option would be turning the global switch off and losing history for everything.

The column is `connections.sampling` (migration `0008-connection-sampling`), two states:

| Value | Meaning |
|-------|---------|
| `''` (default) | follow `metrics.offlineSampling` |
| `skip` | never dial this connection unattended |

What it does **not** do: it does not stop sampling while somebody has a terminal open (that path is
the feature, not the exception), it does not delete rows already stored, and it does not block
opening a terminal, testing the connection, or the status panel. It is a statement about unattended
logins only.

Three ways to set it, in order of preference: the connection form, the API, then direct SQL.

**1. The connection editor.** Expand *Offline sampling* in the form and pick *Skip (never dial this
host)*. Connections marked that way carry a `no sampling` tag in the connection list, so the
exception stays visible instead of hiding in a database column. Choosing *Follow the global
setting* clears the mark again.

**2. The API** (what the editor itself posts to); only the fields you send are changed:

```bash
curl -sS -X POST http://127.0.0.1:9802/api/connection/updateConnection \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"id": "<connection id>", "sampling": "skip"}'
```

**3. Direct SQL**, when the account cannot use the UI or the API:

```sql
-- connections are owner-scoped, so keep owner_id in the WHERE
UPDATE connections SET sampling = 'skip'
 WHERE owner_id = '<owner id>' AND id = '<connection id>';

-- verify
SELECT id, name, host, sampling FROM connections ORDER BY owner_id, id;
```

The API needs an account with the `connections` permission, and it changes only what you send — the
other fields, including the encrypted password, are carried over as-is. The SQL path skips the service
layer: acceptable for a plain `VARCHAR` column, but you also skip the name-uniqueness check, so keep
the statement to that one column. (Connection changes are not written to the audit log on either path —
the audit trail covers commands, AI calls and file transfers.)

It takes effect on the **next round**, no restart: the candidate list is read from MySQL every
minute. Setting it is therefore safe on a live server, and un-setting it is just as cheap.

Clearing it: choose *Follow the global setting* in the form, or send `"sampling": ""` (or `null`)
once through the API. The form now always submits the field — `skip` or `""` — so saving a
connection with the drop-down on *Follow the global setting* does clear a mark that came from the
API or SQL. That is the one case where the form overwrites the column; clients that omit the field
leave it untouched, which is what stops a `skip` from vanishing when some other tool patches a
connection.

Two things worth knowing about the surrounding behaviour:

- The mark does not survive a delete/re-create: a new connection starts at `''`.
- `local` connections can carry `skip` too, but nothing dials them, so it only suppresses the row
  that would otherwise be written from Node's own counters.

Back to: [configuration.md](./configuration.md#metrics) · [troubleshooting.md](./troubleshooting.md)
