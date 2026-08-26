<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <source srcset="docs/logo-light.svg">
    <img alt="cclimit" src="docs/logo-light.png" width="408">
  </picture>
</p>

<p align="center">
  <b>Stop Claude Code before your plan usage runs out.</b><br>
  Halts the turn at a percentage you choose, says how much is left, and waits for you to decide.
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <img alt="network" src="https://img.shields.io/badge/network-none-brightgreen">
  <img alt="runtime" src="https://img.shields.io/badge/node-%E2%89%A518-informational">
</p>

---

## The problem

Your plan has two usage windows: a 5-hour one and a 7-day one. Claude Code shows
the percentages, and then does nothing with them. When you run out, one of two
things happens — the session stops and waits for the reset, or, if extra usage is
enabled on the account, it keeps going and starts billing.

Neither one asks you first. The built-in machinery is all reactive: a
`StopFailure` handler that resumes after a rate limit is hit, a one-time consent
prompt for extra usage, a monthly spend cap. Nothing watches the percentage climb
and stops at a line you drew.

Requests for exactly this ([#47111](https://github.com/anthropics/claude-code/issues/47111),
[#38380](https://github.com/anthropics/claude-code/issues/38380),
[#47157](https://github.com/anthropics/claude-code/issues/47157)) are closed as
not planned. Hence this.

## What it does

You set a line. Usage crosses it. The next thing Claude Code tries to do stops:

```
cclimit: 5h usage hit 87% of your plan (your limit: 85%). Stopped before running Bash.
Window resets Aug 26, 14:20 (in 42m).
Continue until the window resets: /cclimit go — raise the line: /cclimit 5h 92 — turn it off: /cclimit off
The turn ends here either way: ask for the work again afterwards.
```

The reset time is printed in your own locale, on a 24-hour clock.

Nothing runs until you answer. `/cclimit go` stands down until the window resets,
so you are asked once per crossing, not once per tool call.

Subagent launches say so explicitly, because a `Task` call is not one tool call —
it is a whole session's worth of them starting at once.

## Install

```
/plugin marketplace add epogonii/cclimit
/plugin install cclimit@cclimit
/cclimit install
```

That last step is not optional, and it is worth knowing what it does.

The usage percentages exist in exactly one place a plugin can reach: the JSON
payload Claude Code writes to the statusline command's stdin. Hook payloads do
not carry them. So `install` puts a collector in front of whatever statusline you
already have:

```sh
node <plugin>/bin/sink.mjs | your-existing-statusline-command
```

The collector copies stdin through untouched — your statusline looks exactly as it
did — and writes the two percentages to `~/.claude/cclimit/`. `settings.json` is
backed up to `settings.json.cclimit-backup` first, your `padding` is preserved,
and `refreshInterval` is set to 10s if it was missing or slower than 30s,
because a reading nobody refreshes goes stale and cclimit ignores stale
readings.

If you have no statusline, `install` adds a minimal one showing `5h 42% · 7d 11%`.

`/cclimit uninstall` puts the original back and deletes the wrapper.

## Commands

| | |
| --- | --- |
| `/cclimit status` | where usage stands, what the lines are, whether anything is being held |
| `/cclimit 5h 85` | stop at 85% of the 5-hour window |
| `/cclimit 7d 90` | stop at 90% of the 7-day window |
| `/cclimit go` | continue until the current window resets |
| `/cclimit action stop\|ask\|warn` | what a crossing does — see below |
| `/cclimit on` / `/cclimit off` | reinstate / disable, without uninstalling anything |
| `/cclimit install` / `/cclimit uninstall` | wire the collector into the statusline, or remove it |

Claude Code namespaces plugin commands, so each of these is really
`/cclimit:status`, `/cclimit:go` and so on — which is what the `/` menu shows
and completes. The two-word form above works because Claude Code reads the
first word after the plugin name as the command. `/cclimit` on its own does
not resolve to anything; use `/cclimit status`.

All of them are yours to type and Claude's to leave alone. The command files are
marked as not model-invocable, and the gate exempts only a prompt that starts
with `/cclimit` — never a tool call — so the model can neither call the commands
nor reach the binary behind them. It cannot raise the line, snooze, or switch
the plugin off. Deciding to spend past the line is the one thing this plugin
exists to keep in your hands.

## The three actions

**`stop`** (default) — the turn halts outright and the reason is shown. One
interruption per crossing, and nothing runs after it until you say so. The turn
is gone, not paused: `/cclimit go` lifts the line for what comes next, it does
not resume what was interrupted, so ask for the work again afterwards. If
losing the turn is the part you mind, `ask` is the action that keeps it.

**`ask`** — the tool call is routed to the normal permission prompt, so you get
allow/deny in the moment. Be aware of what this costs: a permission answer
applies to that one call. The next tool call asks again. That is a property of
the permission system, not a bug here — it is why `stop` is the default.

**`warn`** — nothing is blocked. A line appears above the answer saying where
usage stands. For people who want the heads-up and not the brakes.

## Where the line should sit

Defaults are 85% of the 5-hour window and 90% of the 7-day one. The 5-hour window
is the one that bites during a working session; the 7-day one is the one that
ends your week early. If your account has extra usage enabled, the numbers past
your line cost money, so set them lower than feels necessary.

## Config

`~/.claude/cclimit/config.json`, written by the commands above:

```json
{
  "enabled": true,
  "action": "stop",
  "thresholds": { "five_hour": 85, "seven_day": 90 },
  "snoozeUntil": null,
  "maxStaleSeconds": 120
}
```

Also in that directory: `limits.json` (the last reading), `breach.json` (present
only while a line is being held), `statusline-wrap.sh` (written by `install`).
Delete the directory to reset.

## How it fails

It fails open, always. No usage data, no config, an unreadable file, a reading
older than `maxStaleSeconds` — every one of those means "carry on", never "block".
A plugin that watches your spending must not be the reason a session stops
working.

Accounts billed through an API key, Bedrock or Vertex have no plan windows at
all: the payload has no `rate_limits`, `/cclimit status` says so, and nothing is
ever held.

## Limits worth knowing before you install it

- **The check runs before a turn or a tool call, not during one.** A single call
  already in flight can carry usage past your line. Set the line where a slight
  overshoot is still fine.
- **It depends on the statusline rendering.** No render, no fresh reading, and
  after `maxStaleSeconds` cclimit stops holding anything. That is deliberate.
- **The percentages are the ones Claude Code publishes**, rounded from floats
  like `56.00000000000001`. Comparison is `>=`, so a line at 85 fires at exactly
  85.0.
- **`ask` re-asks per tool call.** See above.
- **The window state is account-wide**, so a line crossed in one session holds in
  every session on that machine. That is the correct behaviour — the usage is
  shared — but it can be surprising the first time.

## What is not in yet

Auto-resume the moment the window resets (`StopFailure` + a scheduled wake-up),
and dropping to a cheaper model at the line instead of stopping. Both are next.

## Support

The plugin is free and stays free. If it saved you a bill:

| | |
| --- | --- |
| GitHub Sponsors | **[github.com/sponsors/epogonii](https://github.com/sponsors/epogonii)**, monthly or one time |
| PayPal | **[paypal.me/pogonii](https://www.paypal.com/paypalme/pogonii)** |

---

## Licence

MIT. See [LICENSE](LICENSE).
