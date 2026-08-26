# Changelog

## 0.1.3

- The stop message says that the turn is over rather than paused. `/cclimit go`
  lifts the line for what comes next; it cannot resume the turn it interrupted,
  and reading it as a resume is how the interrupted work looks lost.
- Under `warn`, the message no longer says it stopped something. It did not.

## 0.1.2

- The statusline wrapper now runs the most recently installed collector and
  falls back to the path recorded at install time, rather than the other way
  round. Plugin versions are installed side by side and the old directory stays
  put, so preferring the recorded path meant an update never actually took
  effect.
- Reset times are printed on a 24-hour clock. `01:00 PM` costs a beat to read
  in a sentence that has just interrupted you.

## 0.1.1

- The statusline wrapper no longer depends on the collector staying where it
  was at install time. A plugin update moves it into a directory named after
  the new version; the wrapper now searches the plugin cache when the recorded
  path is gone, and passes the payload straight through to your own statusline
  when it cannot find the collector at all. Updating cclimit can no longer
  leave you without a statusline.
- The wordmark is centred against the gauge rather than sharing its baseline.

## 0.1.0

First release.

- Reads the 5-hour and 7-day plan usage percentages out of the statusline
  payload — the only channel that carries them — via a collector piped in front
  of whatever statusline command you already had.
- Holds the session at a threshold you set: `stop` halts the turn, `ask` routes
  the tool call to the permission prompt, `warn` only says something.
- `/cclimit go` stands down until the window resets, so a crossing interrupts
  once rather than once per tool call.
- Subagent launches (`Task`) are called out separately, since one such call
  spends far more than a single tool call.
- Fails open on every unknown: no usage data, no config, unreadable state, or a
  reading older than `maxStaleSeconds`.
- `/cclimit install` backs up `settings.json`, preserves `padding`, and sets
  `refreshInterval` to 10s when it was missing or slower; `/cclimit uninstall`
  restores the original statusline, including one it did not recognise.
- Every subcommand ships as its own command file, so `/cclimit go` and the rest
  resolve as written — Claude Code registers plugin commands as
  `<plugin>:<command>` and reads the first word after the plugin name as the
  command name. The files are not model-invocable: only you can lift the limit.
- The exemption that keeps cclimit's own commands from being blocked applies to
  a prompt beginning with `/cclimit` and to nothing else. Tool calls are never
  exempt, so neither a directory named cclimit nor the model running the binary
  itself can disarm the gate.
- A `resets_at` in any shape other than a Unix timestamp drops the reset time
  from the message instead of printing `Invalid Date`.
