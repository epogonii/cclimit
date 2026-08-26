# Changelog

## 0.5.4

- An interruption is audible. A stop, an `ask` and a `warn` on a tool call now
  ring the terminal bell, because they land in the middle of a turn — which is
  precisely when nobody is looking at the terminal. `/cclimit alert notify`
  adds a desktop notification on terminals that have one, `/cclimit alert off`
  goes back to silence. A blocked prompt stays silent either way: it arrives a
  second after you pressed enter.
- Dropped `suppressOutput` from the hook responses. It is documented as having
  no effect, and carrying it implied a guarantee that was never there.

## 0.5.3

- The message a stop prints is laid out to be read at a glance: the facts on
  their own lines, and the three commands in a column, one to a line, instead of
  run together in a sentence with em-dashes between them.
- A wait is quoted in hours rather than minutes, so a ceiling half a day away
  reads `30h 35m` instead of `1835m`.
- The statusline repair rewrites the lookup on the line it found it on. 0.1.1
  wrote it as the fallback half of a test rather than on a line of its own, and
  a two-line replacement there would have left the second line running
  unconditionally and cleared the pinned path it was meant to keep.
- The demo says what it means. The pixel font drew `N` in three cells, which is
  the same shape as an `M`, so the idle screen read `MO LIME`; `N` and `M` are
  five cells wide now and the screen agrees with its own caption: `NO LIMIT`.

## 0.5.2

- The executables moved out of `bin/` into `scripts/`. A plugin with a
  top-level `bin/` directory cannot be handed out through organization settings
  on claude.ai, which turns it away with
  `marketplace_sync_bin_directory_not_allowed`, and no part of the layout was
  worth that. Hooks and commands point at the new path. Both entry points still
  look for a newer copy of themselves in the plugin cache and hand over to it,
  and they now recognise either shape, so a session that started on an older
  version and a session that started on this one still find each other.
- A statusline wrapper written by an earlier version is repaired the next time
  any `/cclimit` command runs. The wrapper is a file rather than code, so it did
  not change when the plugin did: it went on looking for the collector under
  `bin/`, found the copy an earlier install had left in the cache, and would
  have kept running that older collector for good. Only the two lines that find
  the collector are rewritten, so whatever statusline command was wrapped
  around it is left exactly as it was.
- The test that draws a sparkline no longer insists the busiest stretch lands
  on a particular cell. It was asserting where the peak sat rather than that the
  busy stretch was the tall one, which made it fail on a run that happened to
  bucket the same curve one cell over.
- The README opens with a demo of what the plugin does.

## 0.5.1

- A reading from a session that has been sitting idle no longer overwrites the
  live one. Every open session renders its own statusline and they all write to
  the same state, so an idle window rendering usage from hours ago was taking
  the gates down with it: the stored number would fall back under the line and
  everything held would be let through. Usage inside a window only climbs and
  only a real reset moves the reset time, so a reading that comes back lower in
  the same window, or that carries a reset time already passed, is dropped. Each
  window is judged on its own.
- The sparkline is drawn from the moments the number moved rather than from the
  buckets it happened to land in. Percentages arrive as whole numbers, so steady
  work is a staircase — nothing, nothing, a step — and charting it as it arrived
  drew a comb of spikes with gaps between them, which said the work came in
  bursts it did not come in. The stretch in front of the first step is left out,
  since whatever earned it was partly spent before the trail began, and an even
  burn is drawn as the level line it is instead of scaling up into a wall.

## 0.5.0

- The window announces its own reset. Whatever stopped you turns over on its
  own, and the last thing said about it was that it was full — so the first
  prompt after the reset gets one line saying it is not, what it was before,
  and where the next line sits. A window that never reached its notice or its
  line resets in silence, and the announcement is made once, against the new
  window's reset time.
- `/cclimit downgrade sonnet` answers the line by moving work onto a cheaper
  model instead of stopping. Off unless asked for. Every subagent started past
  the line has its model rewritten to the cheaper one; an already-cheaper call
  is left alone, an ordinary tool call runs untouched, and a ceiling still
  stops everything. Nothing in the hook interface can change the model of the
  session itself, so the prompt is told once — with the `/model` line to type —
  rather than pretending otherwise.
- `status` now projects where the window lands at the current rate, for as long
  as the reset is close enough for that rate to mean anything about it. A rate
  that rounds to nothing, or a target the window will reset long before, is left
  unsaid rather than dressed up as a number.
- `status` also draws the last hour of spending as a sparkline, built from what
  was spent inside each cell rather than the total it stood at — a climbing
  total drawn as a level is a ramp, and a ramp says nothing about when the
  spending happened. The trail kept behind the readings grew from ten minutes
  to an hour to feed it.
- `/cclimit config` prints every setting with the command that changes it. A
  plugin command runs without a terminal of its own, so the arrow-key settings
  screen Claude Code has for itself cannot exist here; the table shows what to
  type instead of hiding it behind a key press. `/cclimit config path` still
  prints the file.

## 0.4.1

- `status` redrawn: each window is a bar with a tick where the work stops,
  and the numbers sit underneath it rather than in one comma-separated line.
  A pending heads-up is no longer reported there as if it were holding work.

## 0.4.0

- Notices. `/cclimit notice 5h 75` says something at 75% while the line still
  stops at 80%, so the stop is not the first news that usage was climbing. It
  blocks nothing, decides nothing, and is off until you set one.
- Said once per window, recorded against that window's reset time: the next
  window says it again, the current one does not repeat it at every tool call,
  and a `/cclimit go` keeps it quiet because the point has already been taken.
- A notice at or above the line is refused, and so is a line at or below a
  notice — a heads-up that arrives with the stop is not a heads-up.
- The message carries the same measured climb rate the ceiling uses, so it says
  how many minutes the room is worth rather than only how many percent.
- The hot path is unchanged in the common case. The pending notice travels in
  the breach file because that file's existence is what wakes the gate at all,
  and the gate clears it the moment the sentence has been delivered.

## 0.3.0

- An update now takes effect in the session that is already running. Claude Code
  resolves a plugin's directory once, at startup, and every version installs
  into a directory of its own, so until now a fix to the part that decides
  whether to stop you sat unused until the next restart. The command and the
  gate both look for a newer installed copy and hand the work to it.
- The handover only happens to a copy that looks whole: the module it imports
  has to be next to it and the file has to parse. A half-written update is a
  directory that exists and does not run, and this plugin is the wrong place to
  turn a working version into no version at all.
- The gate's hot path is untouched. The search happens after the breach check
  and the `node` check, at a point where a process was starting anyway, so the
  cost of the common case — nothing wrong, nothing to do — is the same two file
  tests it always was.

## 0.2.0

- Ceilings. `/cclimit ceiling 5h 99` sets a second, harder number: the line asks
  and can be answered with `/cclimit go`, the ceiling stops and cannot. It
  ignores the snooze, ignores `action` (a `warn` still stops at it), and is as
  far out of the model's reach as everything else here. There is none until you
  set one, so nothing changes for anyone who does not.
- The reason this exists: with one line, "let me finish this" cost the whole
  rest of the window, which made unattended work a choice between a task that
  waits for you and a task that runs to 100%.
- A line crossed while a ceiling is set says how much room is left and, when the
  readings support it, how many minutes that is. The rate is measured from the
  trail of readings in `history.json`; a trail too short, too flat, or crossing
  a window reset produces no estimate rather than a bad one.
- `/cclimit status` shows the ceiling and the climb.
- A line at or above the ceiling, or a ceiling at or below the line, is refused
  with the command that fixes it — the pair only means something in order.

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
