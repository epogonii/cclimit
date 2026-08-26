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

<p align="center">
  <a href="#what-it-does">What it does</a> ·
  <a href="#install">Install</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#the-ceiling">The ceiling</a> ·
  <a href="#the-three-actions">The three actions</a> ·
  <a href="#config">Config</a> ·
  <a href="#how-it-fails">How it fails</a> ·
  <a href="#limits-worth-knowing-before-you-install-it">Limits</a>
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
| `/cclimit ceiling 5h 99` | the number `/cclimit go` cannot lift — `off` removes it |
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

## The ceiling

One line gives you two answers and no third: stop, or `/cclimit go` — which
lifts the line for the rest of the window. Answering "let me finish this" costs
you every percent between here and 100.

A ceiling is that third answer:

```
/cclimit 5h 85            the line: work stops here and asks
/cclimit ceiling 5h 99    the ceiling: work stops here and does not ask
```

`go` still means carry on, and now it carries on to 99 rather than to the end of
the plan.

| | line | ceiling |
| --- | --- | --- |
| What crossing it does | depends on `action` | always stops |
| `/cclimit go` | lifts it until the window resets | says it still stands |
| Under `action warn` | says something, blocks nothing | stops anyway |
| Reachable by the model | no | no |
| Set by default | 85% / 90% | none until you set one |

Removing one is `/cclimit ceiling 5h off`.

What this buys is unattended work. Without a ceiling a long task either waits
for you at the line or, once you have said `go`, runs to the end of the plan
while you are not watching. With one, you can leave.

While a ceiling is set, the stop at the line says how much room is left:

```
cclimit: 5h usage hit 85% of your plan (your limit: 85%). Stopped before running Bash.
Window resets Aug 26, 14:20 (in 42m). Your ceiling is 99%, about 14m away at the current rate.
```

That estimate is measured, not guessed: cclimit keeps the last few dozen
readings and divides. No trail, a flat one, or a window that has just reset —
the sentence simply ends after the ceiling. The model is never asked to predict
anything, and could not act on it if it were.

## The three actions

| | what a crossing does | you keep the turn |
| --- | --- | --- |
| `stop` (default) | halts the turn, once per crossing | no |
| `ask` | routes the tool call to the permission prompt | yes, one call at a time |
| `warn` | prints a line, blocks nothing | yes |

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

All three describe what happens at the *line*. A ceiling always stops.

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
  "ceilings": { "five_hour": null, "seven_day": null },
  "snoozeUntil": null,
  "maxStaleSeconds": 120
}
```

Also in that directory: `limits.json` (the last reading), `history.json` (the
trail behind it, for the climb rate), `breach.json` (present only while a line
is being held), `statusline-wrap.sh` (written by `install`).
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
- **A ceiling is held the same way, and is worth no more than the last
  reading.** It is a brake, not a guarantee: it fails open exactly like the
  line, so a session whose statusline has stopped rendering is a session with no
  ceiling. Leaving work unattended is safe against overshoot, not against the
  plugin being unable to see.
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

<p align="center">
  <a href="https://github.com/sponsors/epogonii"><img alt="Sponsor on GitHub" src="https://img.shields.io/badge/%E2%9D%A4%20Sponsor%20on%20GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white"></a>
  <a href="https://www.paypal.com/paypalme/pogonii"><img alt="Buy me a coffee" src="https://img.shields.io/badge/%E2%98%95%20Buy%20me%20a%20coffee-003087?style=for-the-badge&logo=paypal&logoColor=white"></a>
</p>

| | |
| --- | --- |
| GitHub Sponsors | **[github.com/sponsors/epogonii](https://github.com/sponsors/epogonii)**, monthly or one time |
| PayPal | **[paypal.me/pogonii](https://www.paypal.com/paypalme/pogonii)** |
| Bitcoin | `bc1qe6fjj3uv23e2yx2ry3wwhyrl7s2pqshau7mga3` |
| Ethereum | `0xDC9e1EfA0F8FAE71377F4018d4ff7D123369438e` |
| Solana | `3sYQyR27CVz1VcwCfoDLUioaAHk8jspQaSDHXEvBALxg` |

---

## Licence

MIT. See [LICENSE](LICENSE).
