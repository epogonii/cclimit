# Changelog

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
