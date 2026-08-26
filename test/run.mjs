#!/usr/bin/env node
// End-to-end tests for cclimit. No dependencies, no network, no fixtures.
//
// Everything runs against a throwaway config directory with CCLIMIT_CONFIG_DIR
// pointed at it, so the real ~/.claude — its settings.json above all, which
// install() rewrites — is never read and never written. The usage numbers are
// invented.
//
//   node test/run.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'scripts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cclimit-test-'));
const CONFIG = path.join(ROOT, '.claude');
const STATE = path.join(CONFIG, 'cclimit');

// A test that writes to a real config directory would rewrite the user's
// settings.json, so refuse to run unless the target really is a throwaway.
if (!ROOT.includes('cclimit-test-')) throw new Error(`refusing to run against ${ROOT}`);
fs.mkdirSync(STATE, { recursive: true });

const env = { ...process.env, CCLIMIT_CONFIG_DIR: CONFIG };
const NOW = Math.floor(Date.now() / 1000);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function run(script, args = [], input = '', extraEnv = null) {
  return spawnSync('node', [path.join(BIN, script), ...args], {
    input,
    env: extraEnv ? { ...env, ...extraEnv } : env,
    encoding: 'utf8',
  });
}

// The terminal the suite itself is running in decides what a notification
// should look like, so every check that cares about one says which terminal it
// is pretending to be, starting from none of them.
const NO_TERMINAL = { TERM_PROGRAM: '', TERM: 'dumb', WT_SESSION: '', ConEmuPID: '' };

function cli(...args) {
  const res = run('cclimit.mjs', args);
  if (res.status !== 0 && !args.includes('--expect-fail')) {
    throw new Error(`cclimit ${args.join(' ')} exited ${res.status}: ${res.stderr}`);
  }
  return res.stdout;
}

function statusline(fiveHour, sevenDay, extra = {}) {
  return JSON.stringify({
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    session_id: 'test-session',
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: NOW + 3600 },
      seven_day: { used_percentage: sevenDay, resets_at: NOW + 86400 },
    },
    ...extra,
  });
}

// Most checks set an absolute state and read what came of it, so each one is
// the collector's first sight of the numbers it is given. Without this, a
// reading lower than the one a previous check left behind would be discarded
// as stale — which is the point of the rule, and is exercised on its own with
// `feedAgain` below rather than in every check that lowers a number.
function feed(fiveHour, sevenDay) {
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  return feedAgain(fiveHour, sevenDay);
}

function feedAgain(fiveHour, sevenDay, extra = {}) {
  const payload = statusline(fiveHour, sevenDay, extra);
  const res = run('sink.mjs', [], payload);
  return { res, payload };
}

function gate(event, extra = {}, extraEnv = null) {
  const payload = JSON.stringify({ hook_event_name: event, session_id: 'test-session', ...extra });
  const res = run('gate.mjs', [], payload, extraEnv);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

function breachFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, 'breach.json'), 'utf8'));
  } catch {
    return null;
  }
}

// --- the collector ----------------------------------------------------------

check('sink copies the statusline payload through untouched', () => {
  const { res, payload } = feed(20, 10);
  eq(res.stdout, payload, 'stdout');
});

check('sink records the usage it saw', () => {
  feed(20, 10);
  const stored = JSON.parse(fs.readFileSync(path.join(STATE, 'limits.json'), 'utf8'));
  eq(stored.rate_limits.five_hour.used_percentage, 20, 'five_hour');
});

// --- a reading from a session that has been sitting idle --------------------

function storedLimits() {
  return JSON.parse(fs.readFileSync(path.join(STATE, 'limits.json'), 'utf8')).rate_limits;
}

check('a reading lower than the last one in the same window is not believed', () => {
  feed(90, 10);
  feedAgain(30, 10);
  eq(storedLimits().five_hour.used_percentage, 90, 'five_hour');
  eq(breachFile()?.used_percentage, 90, 'breach percentage');
});

check('the trail records the number the gates act on', () => {
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
  feed(90, 10);
  feedAgain(30, 10);
  const history = JSON.parse(fs.readFileSync(path.join(STATE, 'history.json'), 'utf8'));
  eq(history[history.length - 1].five_hour, 90, 'last reading');
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

check('a reading from a window that has already reset is ignored', () => {
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  feedWindows(60, NOW + 3600, 10, NOW + 86400);
  feedWindows(88, NOW + 600, 10, NOW + 86400);
  eq(storedLimits().five_hour.used_percentage, 60, 'five_hour');
});

check('a window that really has reset is taken at its word', () => {
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  feedWindows(90, NOW + 600, 10, NOW + 86400);
  feedWindows(4, NOW + 3600, 10, NOW + 86400);
  eq(storedLimits().five_hour.used_percentage, 4, 'five_hour');
  // That last pair is a rollover, which arms the announcement for it.
  fs.rmSync(path.join(STATE, 'resume.json'), { force: true });
  fs.rmSync(path.join(STATE, 'breach.json'), { force: true });
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
});

check('one window going stale does not hold the other back', () => {
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  feedWindows(60, NOW + 3600, 40, NOW + 86400);
  feedWindows(20, NOW + 3600, 41, NOW + 86400);
  eq(storedLimits().five_hour.used_percentage, 60, 'five_hour');
  eq(storedLimits().seven_day.used_percentage, 41, 'seven_day');
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
});

check('usage below the line leaves no breach', () => {
  feed(20, 10);
  eq(breachFile(), null, 'breach file');
});

check('usage over the line writes a breach', () => {
  feed(90, 10);
  const b = breachFile();
  eq(b.window, 'five_hour', 'window');
  eq(b.threshold, 85, 'threshold');
});

check('usage falling back under clears the breach', () => {
  feed(90, 10);
  feed(20, 10);
  eq(breachFile(), null, 'breach file');
});

check('a percentage exactly on the line counts as over', () => {
  // 85.00000000000001 is the kind of float the payload actually carries, and
  // the reason the comparison is >= rather than ==.
  feed(85.00000000000001, 10);
  eq(breachFile().window, 'five_hour', 'window');
});

check('the window further past its line is the one reported', () => {
  feed(86, 99);
  eq(breachFile().window, 'seven_day', 'window');
});

check('an account with no usage windows is left alone', () => {
  const res = run('sink.mjs', [], JSON.stringify({ model: { id: 'x' } }));
  eq(res.status, 0, 'exit status');
  eq(breachFile(), null, 'breach file');
});

check('sink survives input that is not JSON at all', () => {
  const res = run('sink.mjs', [], 'not json');
  eq(res.status, 0, 'exit status');
  eq(res.stdout, 'not json', 'stdout');
});

check('--render prints a usage line instead of the payload', () => {
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  const res = run('sink.mjs', ['--render'], statusline(42, 11));
  if (!/5h 42%/.test(res.stdout)) throw new Error(`no usage in: ${res.stdout}`);
  if (!/7d 11%/.test(res.stdout)) throw new Error(`no 7d usage in: ${res.stdout}`);
});

// --- the gates --------------------------------------------------------------

check('no breach means the gate says nothing', () => {
  feed(20, 10);
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
});

check('stop halts the turn on a tool call', () => {
  feed(90, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  eq(res.continue, false, 'continue');
  if (!/90%/.test(res.stopReason)) throw new Error(`percentage missing from: ${res.stopReason}`);
  if (!/\/cclimit go/.test(res.stopReason)) throw new Error(`no way out offered in: ${res.stopReason}`);
});

check('stop blocks a prompt before the turn starts', () => {
  feed(90, 10);
  const res = gate('UserPromptSubmit', { prompt: 'keep going' });
  eq(res.decision, 'block', 'decision');
  // Without this the prompt is echoed back under the reason and buries it.
  eq(res.hookSpecificOutput.suppressOriginalPrompt, true, 'suppressOriginalPrompt');
});

// /cclimit go lifts the line for the next turn; it cannot revive this one.
check('stop says the turn will not come back on its own', () => {
  feed(90, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  if (!/ask for the work again/.test(res.stopReason)) throw new Error(`no warning that the turn is gone: ${res.stopReason}`);
});

check('warn does not claim to have stopped anything', () => {
  feed(90, 10);
  cli('action', 'warn');
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  if (/Stopped|ask for the work again/.test(res.systemMessage)) throw new Error(`warn message overstates itself: ${res.systemMessage}`);
  cli('action', 'stop');
});

check('a subagent launch says what it would have cost', () => {
  feed(90, 10);
  const res = gate('PreToolUse', { tool_name: 'Task', tool_input: { prompt: 'go' } });
  if (!/subagent/.test(res.stopReason)) throw new Error(`no subagent warning in: ${res.stopReason}`);
});

check('ask routes the call to the permission prompt', () => {
  feed(90, 10);
  cli('action', 'ask');
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  eq(res.hookSpecificOutput.permissionDecision, 'ask', 'permissionDecision');
  eq(res.hookSpecificOutput.hookEventName, 'PreToolUse', 'hookEventName');
});

check('warn lets the call run and only says something', () => {
  feed(90, 10);
  cli('action', 'warn');
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  eq(res.continue, undefined, 'continue');
  if (!/90%/.test(res.systemMessage)) throw new Error(`no percentage in: ${res.systemMessage}`);
  cli('action', 'stop');
});

const BELL = '\u0007';
const tool = { tool_name: 'Bash', tool_input: { command: 'ls' } };

// A stop lands mid-turn, which is when the user is least likely to be looking
// at the terminal — the whole reason the plugin exists.
check('a stop rings the bell', () => {
  feed(90, 10);
  const res = gate('PreToolUse', tool, NO_TERMINAL);
  eq(res.terminalSequence, BELL, 'terminalSequence');
});

// The user pressed enter a second ago and is still watching the screen.
check('a blocked prompt does not ring', () => {
  feed(90, 10);
  const res = gate('UserPromptSubmit', { prompt: 'keep going' }, NO_TERMINAL);
  eq(res.terminalSequence, undefined, 'terminalSequence');
});

check('ask and warn ring on a tool call too', () => {
  for (const action of ['ask', 'warn']) {
    // A warn spends its bell once a window, so start each one unspent.
    fs.rmSync(path.join(STATE, 'notice.json'), { force: true });
    feed(90, 10);
    cli('action', action);
    eq(gate('PreToolUse', tool, NO_TERMINAL).terminalSequence, BELL, `terminalSequence under ${action}`);
  }
  cli('action', 'stop');
});

// A warn does not block, so the same breach comes back on the very next tool
// call. Repeating the line is the whole action; repeating the bell would be the
// interruption a warn is chosen to avoid.
check('a warn rings once a window, not once a tool call', () => {
  fs.rmSync(path.join(STATE, 'notice.json'), { force: true });
  feed(90, 10);
  cli('action', 'warn');
  const first = gate('PreToolUse', tool, NO_TERMINAL);
  const second = gate('PreToolUse', tool, NO_TERMINAL);
  eq(first.terminalSequence, BELL, 'the first tool call rings');
  eq(second.terminalSequence, undefined, 'the second tool call does not');
  eq(second.systemMessage, first.systemMessage, 'the warning itself carries on');

  // A bell spent in the window before this one is not this window's bell.
  fs.writeFileSync(path.join(STATE, 'notice.json'), JSON.stringify({ 'alert:five_hour': NOW - 99999 }));
  eq(gate('PreToolUse', tool, NO_TERMINAL).terminalSequence, BELL, 'a new window rings again');
  fs.rmSync(path.join(STATE, 'notice.json'), { force: true });
  cli('action', 'stop');
});

check('alert off says nothing to the terminal', () => {
  feed(90, 10);
  cli('alert', 'off');
  eq(gate('PreToolUse', tool, NO_TERMINAL).terminalSequence, undefined, 'terminalSequence');
  cli('alert', 'bell');
});

// A heads-up is not an interruption: it is printed above work that carries on.
check('a notice does not ring', () => {
  cli('notice', '5h', '70');
  feed(75, 10);
  const res = gate('PreToolUse', tool, NO_TERMINAL);
  eq(res.terminalSequence, undefined, 'terminalSequence');
  cli('notice', '5h', 'off');
});

check('notify adds a notification the terminal understands', () => {
  cli('alert', 'notify');
  feed(90, 10);

  const iterm = gate('PreToolUse', tool, { ...NO_TERMINAL, TERM_PROGRAM: 'iTerm.app' }).terminalSequence;
  if (!iterm.startsWith(`${BELL}\u001b]9;cclimit: 5h usage 90%`)) {
    throw new Error(`not an OSC 9 notification: ${JSON.stringify(iterm)}`);
  }

  const kitty = gate('PreToolUse', tool, { ...NO_TERMINAL, TERM: 'xterm-kitty' }).terminalSequence;
  if (!kitty.startsWith(`${BELL}\u001b]99;;cclimit:`)) {
    throw new Error(`not an OSC 99 notification: ${JSON.stringify(kitty)}`);
  }

  // Outside macOS almost nothing sets TERM_PROGRAM, so TERM has to be enough
  // on its own for the terminals that ship on Linux.
  for (const [term, osc] of [
    ['xterm-ghostty', '777'],
    ['rxvt-unicode-256color', '777'],
    ['foot-extra', '777'],
    ['wezterm', '9'],
  ]) {
    const seq = gate('PreToolUse', tool, { ...NO_TERMINAL, TERM: term }).terminalSequence;
    if (!seq.startsWith(`${BELL}\u001b]${osc};`)) {
      throw new Error(`TERM=${term} did not reach OSC ${osc}: ${JSON.stringify(seq)}`);
    }
  }

  // Sending a terminal a sequence it does not know can print the payload as
  // text, so an unrecognised one gets the bell and nothing else. GNOME Terminal
  // is the case worth naming: OSC 777 reached VTE as a distribution patch, so
  // the same terminal answers it on one machine and ignores it on the next.
  for (const env of [NO_TERMINAL, { ...NO_TERMINAL, TERM: 'xterm-256color', VTE_VERSION: '7600' }]) {
    eq(gate('PreToolUse', tool, env).terminalSequence, BELL, `terminalSequence for ${JSON.stringify(env)}`);
  }
  cli('alert', 'bell');
});

// Claude Code drops the whole field if any part of it is outside its
// allowlist, so a stray CSI would silently cost the bell as well.
check('the alert never leaves the allowlist', () => {
  cli('alert', 'notify');
  feed(90, 10);
  const terminals = [
    { TERM_PROGRAM: 'iTerm.app' },
    { TERM_PROGRAM: 'WezTerm' },
    { TERM_PROGRAM: 'ghostty' },
    { TERM_PROGRAM: 'WarpTerminal' },
    { TERM: 'xterm-kitty' },
    { TERM: 'rxvt-unicode-256color' },
    { TERM: 'foot' },
    { WT_SESSION: '1' },
  ];
  for (const term of terminals) {
    const seq = gate('PreToolUse', tool, { ...NO_TERMINAL, ...term }).terminalSequence;
    for (const part of seq.split('\u001b]').slice(1)) {
      const code = part.split(';')[0];
      if (!['0', '1', '2', '9', '99', '777'].includes(code)) {
        throw new Error(`OSC ${code} is not allowlisted, from ${JSON.stringify(term)}`);
      }
    }
    if (/\u001b[^\]\\]/.test(seq)) throw new Error(`not an OSC sequence: ${JSON.stringify(seq)}`);
  }
  cli('alert', 'bell');
});

// The user's escape hatches are slash commands, and a slash command reaches
// this hook as a prompt. The `!` line inside the command file that does the
// actual work runs without firing PreToolUse, so this one exemption is the
// whole of what the escape hatches need.
check('the slash commands that turn cclimit off are never blocked', () => {
  feed(90, 10);
  for (const prompt of ['/cclimit go', '/cclimit off', '/cclimit:go', '/cclimit 5h 95']) {
    eq(gate('UserPromptSubmit', { prompt }), null, `response to ${prompt}`);
  }
});

// The exemption above is the one hole in the gate, and it has to stay exactly
// the size of the commands it exists for. Two ways it could grow: the word
// appearing in an unrelated path, and — the one that matters — the model
// running the binary itself to lift a limit the user set on it.
check('nothing but a slash command gets past the gate', () => {
  feed(90, 10);
  const cases = [
    ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'node /plugins/cclimit/scripts/cclimit.mjs off' } }],
    ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat /home/me/cclimit/notes.md' } }],
    ['PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/home/me/cclimit/README.md' } }],
    ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit -m "cclimit: fix the gate"' } }],
    ['UserPromptSubmit', { prompt: 'add a test to cclimit for this' }],
  ];
  for (const [event, extra] of cases) {
    const res = gate(event, extra);
    const held = res?.continue === false || res?.decision === 'block';
    if (!held) throw new Error(`not held: ${JSON.stringify(extra)} gave ${JSON.stringify(res)}`);
  }
});

// `resets_at` is a Unix timestamp in seconds today. If that ever changes shape,
// the message the user reads must lose the reset sentence, not carry an
// "Invalid Date (in NaNm)" through the middle of it.
// `01:00 PM` costs a beat to read in a sentence that has just interrupted you.
check('the reset time is on a 24-hour clock', () => {
  feed(90, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  if (/\b[AP]\.?M\.?\b/i.test(res.stopReason)) throw new Error(`12-hour clock in: ${res.stopReason}`);
  if (!/resets .*\d{2}:\d{2}/.test(res.stopReason)) throw new Error(`no reset time in: ${res.stopReason}`);
});

check('a reset time in an unexpected shape drops out of the message', () => {
  const payload = statusline(92, 10, {
    rate_limits: {
      five_hour: { used_percentage: 92, resets_at: '2026-08-26T12:08:00Z' },
      seven_day: { used_percentage: 10, resets_at: null },
    },
  });
  run('sink.mjs', [], payload);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  eq(res.continue, false, 'continue');
  if (/Invalid Date|NaN|undefined|null/.test(res.stopReason)) {
    throw new Error(`unreadable message: ${res.stopReason}`);
  }
  if (!/92%/.test(res.stopReason)) throw new Error(`lost the percentage: ${res.stopReason}`);
  const status = cli('status');
  if (/Invalid Date|NaN|null/.test(status)) throw new Error(`unreadable status: ${status}`);
});

check('a stale reading is treated as no reading', () => {
  feed(90, 10);
  const b = breachFile();
  fs.writeFileSync(path.join(STATE, 'breach.json'), JSON.stringify({ ...b, ts: NOW - 600 }));
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
});

check('the gate rechecks the config, not just the breach file', () => {
  feed(90, 10);
  // Raising the line has to take effect on the next tool call, without waiting
  // for a statusline render to rewrite the breach file.
  const b = breachFile();
  cli('5h', '95');
  fs.writeFileSync(path.join(STATE, 'breach.json'), JSON.stringify(b));
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
  cli('5h', '85');
});

// --- the command surface ----------------------------------------------------

check('a bare number sets the 5-hour line', () => {
  cli('70');
  const config = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
  eq(config.thresholds.five_hour, 70, 'five_hour threshold');
  cli('85');
});

check('7d takes its own line', () => {
  cli('7d', '60');
  const config = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
  eq(config.thresholds.seven_day, 60, 'seven_day threshold');
  cli('7d', '90');
});

check('a nonsense threshold is refused', () => {
  const res = run('cclimit.mjs', ['5h', '500']);
  if (res.status === 0) throw new Error('accepted 500%');
});

check('go stands down until the window resets', () => {
  feed(90, 10);
  cli('go');
  eq(breachFile(), null, 'breach file');
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
  const config = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
  if (config.snoozeUntil <= NOW) throw new Error(`snooze is in the past: ${config.snoozeUntil}`);
});

check('a fresh reading during a snooze stays quiet', () => {
  feed(95, 10);
  eq(breachFile(), null, 'breach file');
});

check('on clears the snooze and restores the hold', () => {
  cli('on');
  feed(95, 10);
  eq(breachFile().window, 'five_hour', 'window');
});

// A session that sat idle through a rollover has a breach file naming a window
// that is already over. Taking its reset time at face value writes a snooze
// that expired before it was saved: the next tool call is stopped again, and
// the sentence just printed said it would not be.
check('go never stands down until a moment already past', () => {
  feed(90, 10);
  const stale = JSON.parse(fs.readFileSync(path.join(STATE, 'breach.json'), 'utf8'));
  fs.writeFileSync(path.join(STATE, 'breach.json'), JSON.stringify({ ...stale, resets_at: NOW - 600 }) + '\n');

  const text = cli('go');
  const config = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
  if (config.snoozeUntil <= NOW) throw new Error(`snooze is in the past: ${config.snoozeUntil}`);
  // The live reading still has a reset ahead of it, so that is the one the
  // stand-down runs to rather than the one the stale file named.
  eq(config.snoozeUntil, NOW + 3600, 'snoozed until the next reset still to come');
  if (!/standing down/.test(text)) throw new Error(`unexpected output: ${text}`);
  // And the stand-down has to actually hold, which is the whole point of it.
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
  cli('on');
});

// With no reset time anywhere to go on, an hour is the fallback — and an hour
// from now is still an hour from now.
check('go falls back to an hour when no reset time is known', () => {
  cli('on');
  fs.rmSync(path.join(STATE, 'breach.json'), { force: true });
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  cli('go');
  const config = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
  if (config.snoozeUntil <= NOW) throw new Error(`snooze is in the past: ${config.snoozeUntil}`);
  cli('on');
});

check('off means nothing is blocked at all', () => {
  cli('off');
  feed(95, 99);
  eq(breachFile(), null, 'breach file');
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
  cli('on');
});

check('status reports usage and the line it is holding', () => {
  feed(95, 10);
  const text = cli('status');
  if (!/95%/.test(text)) throw new Error(`no usage in: ${text}`);
  if (!/85%/.test(text)) throw new Error(`no threshold in: ${text}`);
});

// --- the ceiling ------------------------------------------------------------
//
// The line is a question and the ceiling is not. Everything below is about that
// difference: `go` answers the line, and the ceiling is the number that answer
// does not reach.

function ceilingOff() {
  cli('ceiling', '5h', 'off');
  cli('ceiling', '7d', 'off');
  cli('on');
  cli('action', 'stop');
}

check('no ceiling exists until one is set', () => {
  ceilingOff();
  const { config } = JSON.parse(cli('status', '--json'));
  eq(config.ceilings, { five_hour: null, seven_day: null }, 'ceilings');
});

check('go lifts the line', () => {
  ceilingOff();
  feed(90, 10);
  cli('go');
  feed(95, 10);
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
  cli('on');
});

check('go does not lift the ceiling', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  feed(90, 10);
  cli('go');
  feed(96, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  eq(res.continue, false, 'continue');
  if (!/ceiling/.test(res.stopReason)) throw new Error(`not reported as a ceiling: ${res.stopReason}`);
  ceilingOff();
});

check('a ceiling stops even when the action is only to warn', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  cli('action', 'warn');
  feed(96, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  eq(res.continue, false, 'continue');
  ceilingOff();
});

check('the ceiling message offers the ways out that exist', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  feed(96, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  if (!/\/cclimit ceiling 5h off/.test(res.stopReason)) throw new Error(`no way to remove it: ${res.stopReason}`);
  // Offering `go` here would be offering something that does not work.
  if (/Continue until the window resets/.test(res.stopReason)) throw new Error(`offers a snooze it will ignore: ${res.stopReason}`);
  ceilingOff();
});

check('the ceiling outranks a line the other window is further past', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  feed(96, 99);
  eq(breachFile().window, 'five_hour', 'window');
  eq(breachFile().kind, 'ceiling', 'kind');
  ceilingOff();
});

check('a ceiling at or below the line is refused', () => {
  ceilingOff();
  const res = run('cclimit.mjs', ['ceiling', '5h', '85']);
  eq(res.status, 1, 'exit status');
  if (!/leaves the line no room/.test(res.stderr)) throw new Error(`unhelpful refusal: ${res.stderr}`);
});

check('a line at or above the ceiling is refused', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  const res = run('cclimit.mjs', ['5h', '95']);
  eq(res.status, 1, 'exit status');
  if (!/never fire/.test(res.stderr)) throw new Error(`unhelpful refusal: ${res.stderr}`);
  ceilingOff();
});

check('removing the ceiling gives go back the rest of the window', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  cli('ceiling', '5h', 'off');
  feed(90, 10);
  cli('go');
  feed(99, 10);
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
  cli('on');
});

// --- the heads-up -----------------------------------------------------------

function noticeFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, 'notice.json'), 'utf8'));
  } catch {
    return null;
  }
}

function resetNotices() {
  fs.rmSync(path.join(STATE, 'notice.json'), { force: true });
  cli('5h', '80');
  cli('notice', '5h', 'off');
  cli('7d', '90');
  cli('notice', '7d', 'off');
  cli('on');
}

check('no notice is set by default', () => {
  resetNotices();
  const config = JSON.parse(cli('status', '--json')).config;
  eq(config.notices, { five_hour: null, seven_day: null }, 'notices');
});

check('nothing is said below the notice', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(70, 10);
  eq(breachFile(), null, 'breach file');
});

check('crossing the notice wakes the gate without blocking anything', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(76, 10);
  eq(breachFile().kind, 'notice', 'kind');
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  if (res.continue === false) throw new Error('a notice blocked a tool call');
  if (res.hookSpecificOutput) throw new Error('a notice made a permission decision');
  if (!/76%/.test(res.systemMessage)) throw new Error(`no usage in the message: ${res.systemMessage}`);
  if (!/stops at 80%/.test(res.systemMessage)) throw new Error(`no line in the message: ${res.systemMessage}`);
});

check('the notice is said once and then gets out of the way', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(76, 10);
  gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  eq(breachFile(), null, 'breach file after the notice');
  eq(noticeFile().five_hour, NOW + 3600, 'recorded against the reset time');
  // The next render must not put it back: the hot path has to go cold again,
  // or every tool call between here and the line starts Node for nothing.
  feed(77, 10);
  eq(breachFile(), null, 'breach file after another render');
});

check('a notice above a prompt says something and eats nothing', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(76, 10);
  const res = gate('UserPromptSubmit', { prompt: 'carry on with the refactor' });
  if (res.decision) throw new Error(`a notice blocked a prompt: ${JSON.stringify(res)}`);
  if (!/76%/.test(res.systemMessage)) throw new Error(`no usage in the message: ${res.systemMessage}`);
  eq(breachFile(), null, 'breach file');
});

check('a new window says it again', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(76, 10);
  gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  fs.writeFileSync(path.join(STATE, 'notice.json'), JSON.stringify({ five_hour: NOW - 99999 }));
  feed(76, 10);
  eq(breachFile().kind, 'notice', 'kind');
});

check('moving the notice re-arms it', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(76, 10);
  gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  cli('notice', '5h', '70');
  feed(76, 10);
  eq(breachFile().kind, 'notice', 'kind');
});

check('past the line the line does the talking', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(90, 10);
  eq(breachFile().kind, 'line', 'kind');
});

check('a snoozed session is not told again', () => {
  resetNotices();
  cli('notice', '5h', '75');
  cli('go');
  feed(76, 10);
  eq(breachFile(), null, 'breach file');
  cli('on');
});

check('a notice at or above the line is refused', () => {
  resetNotices();
  const res = run('cclimit.mjs', ['notice', '5h', '80']);
  if (res.status === 0) throw new Error('accepted a notice on top of the line');
  if (!/below the line/.test(res.stderr)) throw new Error(`unhelpful refusal: ${res.stderr}`);
});

check('a line at or below the notice is refused', () => {
  resetNotices();
  cli('notice', '5h', '75');
  const res = run('cclimit.mjs', ['5h', '75']);
  if (res.status === 0) throw new Error('accepted a line under the notice');
  if (!/arrive with the stop/.test(res.stderr)) throw new Error(`unhelpful refusal: ${res.stderr}`);
  resetNotices();
});

check('a pending heads-up is not reported as a hold', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(76, 10);
  const text = cli('status');
  if (/Currently holding/.test(text)) throw new Error(`a notice claimed a hold: ${text}`);
  cli('notice', '5h', 'off');
});

check('status draws the window as a bar', () => {
  feed(50, 10);
  const text = cli('status');
  if (!/\u2588+\u2591*/.test(text)) throw new Error(`no bar in status: ${text}`);
  if (!text.includes('\u2502')) throw new Error(`no stop mark in status: ${text}`);
});

check('status names the notice', () => {
  resetNotices();
  cli('notice', '5h', '75');
  feed(70, 10);
  const text = cli('status');
  if (!/notice at 75%/.test(text)) throw new Error(`notice missing from status: ${text}`);
  resetNotices();
});

// --- how fast it is climbing ------------------------------------------------

function writeHistory(points) {
  fs.writeFileSync(path.join(STATE, 'history.json'), JSON.stringify(points));
}

check('the collector keeps a trail of readings', () => {
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
  feed(20, 10);
  feed(21, 10);
  const history = JSON.parse(fs.readFileSync(path.join(STATE, 'history.json'), 'utf8'));
  if (history.length < 2) throw new Error(`trail too short: ${JSON.stringify(history)}`);
  eq(history[history.length - 1].five_hour, 21, 'last reading');
});

check('a line breach says how far the ceiling is at the current rate', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  // Ten minutes of readings climbing a point a minute: the ceiling is five
  // points and therefore about five minutes away.
  writeHistory(Array.from({ length: 11 }, (_, i) => ({ ts: NOW - (10 - i) * 60, five_hour: 80 + i, seven_day: 10 })));
  feed(90, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  if (!/ceiling is 95%/.test(res.stopReason)) throw new Error(`ceiling not mentioned: ${res.stopReason}`);
  if (!/about 5m away/.test(res.stopReason)) throw new Error(`no usable estimate: ${res.stopReason}`);
  ceilingOff();
});

check('a trail too short or too flat produces no estimate at all', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  for (const trail of [
    [],
    [{ ts: NOW - 30, five_hour: 89 }, { ts: NOW, five_hour: 90 }],
    [{ ts: NOW - 600, five_hour: 90 }, { ts: NOW, five_hour: 90 }],
    [{ ts: NOW - 600, five_hour: 95 }, { ts: NOW, five_hour: 2 }],
  ]) {
    writeHistory(trail);
    feed(90, 10);
    const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    if (/away at the current rate/.test(res.stopReason)) throw new Error(`invented an estimate from ${JSON.stringify(trail)}`);
    if (!/ceiling is 95%/.test(res.stopReason)) throw new Error(`lost the ceiling: ${res.stopReason}`);
  }
  ceilingOff();
});

// A stop is read by someone who has just been interrupted, so the message has
// to be scannable: the facts on their own lines, the commands in a column.
check('the stop message puts one command on each line', () => {
  ceilingOff();
  feed(90, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  const lines = String(res.stopReason).split('\n');
  const commands = lines.filter((line) => /^ {2}\/cclimit /.test(line));
  eq(commands.length, 3, 'three commands, one to a line');
  // Aligned, so the descriptions read as a column rather than as ragged prose.
  const columns = new Set(commands.map((line) => line.match(/^ {2}\S.*?\s{2,}/)[0].length));
  eq(columns.size, 1, 'the descriptions start at the same column');
  if (!/^cclimit: 5h usage hit .*\(your limit: \d+%\)\.$/.test(lines[0])) {
    throw new Error(`the first line is not the fact on its own: ${lines[0]}`);
  }
  if (/\u2014 raise the line|\u2014 turn it off/.test(res.stopReason)) {
    throw new Error(`the commands are still run together: ${res.stopReason}`);
  }
});

// `740m` has to be divided before it means anything, and the person reading it
// has just been stopped mid-task.
check('a long wait is quoted in hours', () => {
  ceilingOff();
  cli('5h', '20');
  cli('ceiling', '5h', '95');
  // A tenth of a point a minute, 74 points of headroom: 740 minutes.
  writeHistory(Array.from({ length: 11 }, (_, i) => ({ ts: NOW - (10 - i) * 60, five_hour: 20 + i / 10, seven_day: 10 })));
  feed(21, 10);
  const res = gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  if (!/about 12h \d+m away at the current rate/.test(res.stopReason)) {
    throw new Error(`the wait is not in hours: ${res.stopReason}`);
  }
  ceilingOff();
  cli('5h', '85');
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

check('status shows the ceiling and the climb', () => {
  ceilingOff();
  cli('ceiling', '5h', '95');
  writeHistory(Array.from({ length: 11 }, (_, i) => ({ ts: NOW - (10 - i) * 60, five_hour: 80 + i, seven_day: 10 })));
  feed(90, 10);
  const text = cli('status');
  if (!/ceiling 95%/.test(text)) throw new Error(`no ceiling in status: ${text}`);
  if (!/climbing 1\.0%\/min/.test(text)) throw new Error(`no rate in status: ${text}`);
  if (!/95% in about 5m/.test(text)) throw new Error(`no estimate in status: ${text}`);
  ceilingOff();
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

// --- wiring the collector in ------------------------------------------------

check('install pipes the collector in front of an existing statusline', () => {
  const settingsFile = path.join(CONFIG, 'settings.json');
  const original = { type: 'command', command: 'my-statusline --fancy', padding: 2 };
  fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: original, model: 'opus' }, null, 2));

  cli('install');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  eq(settings.model, 'opus', 'unrelated settings');
  eq(settings.statusLine.padding, 2, 'padding');
  eq(settings.statusLine.refreshInterval, 10, 'refreshInterval');
  if (!settings.statusLine.command.includes('cclimit')) throw new Error(`statusline not rewired: ${settings.statusLine.command}`);

  const wrapper = fs.readFileSync(path.join(STATE, 'statusline-wrap.sh'), 'utf8');
  if (!wrapper.includes('my-statusline --fancy')) throw new Error(`original command lost: ${wrapper}`);
  if (!wrapper.includes('sink.mjs')) throw new Error(`collector missing: ${wrapper}`);
  if (!fs.existsSync(`${settingsFile}.cclimit-backup`)) throw new Error('no backup written');
});

check('install run twice changes nothing the second time', () => {
  const settingsFile = path.join(CONFIG, 'settings.json');
  const before = fs.readFileSync(settingsFile, 'utf8');
  const text = cli('install');
  eq(fs.readFileSync(settingsFile, 'utf8'), before, 'settings.json');
  if (!/already/.test(text)) throw new Error(`unexpected output: ${text}`);
});

check('uninstall puts the original statusline back', () => {
  const settingsFile = path.join(CONFIG, 'settings.json');
  cli('uninstall');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  eq(settings.statusLine.command, 'my-statusline --fancy', 'command');
  eq(settings.statusLine.padding, 2, 'padding');
  eq(fs.existsSync(path.join(STATE, 'statusline-wrap.sh')), false, 'wrapper removed');
});

check('install adds its own statusline when there is none', () => {
  const settingsFile = path.join(CONFIG, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }, null, 2));
  cli('install');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (!settings.statusLine.command.includes('cclimit')) throw new Error(`unexpected command: ${settings.statusLine.command}`);
  const wrapper = fs.readFileSync(path.join(STATE, 'statusline-wrap.sh'), 'utf8');
  if (!wrapper.includes('--render')) throw new Error(`collector not asked to render: ${wrapper}`);
  cli('uninstall');
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  eq(after.statusLine, undefined, 'statusLine after uninstall');
});

// A plugin update moves the collector into a directory named after the new
// version, so the path recorded at install time stops existing. Whatever else
// that costs, it must not cost the user their statusline.
check('the wrapper still runs the statusline when the collector has moved', () => {
  const settingsFile = path.join(CONFIG, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: 'cat' } }, null, 2));
  cli('install');

  const wrapper = fs.readFileSync(path.join(STATE, 'statusline-wrap.sh'), 'utf8');
  // The newest installed copy has to be preferred over the path recorded here,
  // or an update would leave the old collector running for good: plugin
  // versions are installed side by side and the old directory stays put.
  const search = wrapper.indexOf('ls -1dt');
  const recorded = wrapper.indexOf('|| SINK=');
  if (search < 0 || recorded < 0) throw new Error(`wrapper does not look up the collector: ${wrapper}`);
  if (search > recorded) throw new Error(`recorded path wins over the newest install: ${wrapper}`);

  // Point both the cache search and the recorded path at nothing, which is what
  // an uninstalled or renamed version directory looks like from here.
  const moved = path.join(STATE, 'moved-wrap.sh');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cclimit-empty-'));
  const gone = `'${path.join(empty, 'gone.mjs')}'`;
  fs.writeFileSync(
    moved,
    wrapper.replace(/^SINK=.*$/m, `SINK=${gone}`).replace(/^\[ -f "\$SINK" \] \|\| SINK=.*$/m, `[ -f "$SINK" ] || SINK=${gone}`),
    { mode: 0o755 }
  );

  const run = spawnSync('sh', [moved], { input: 'payload from claude code', encoding: 'utf8', env: { ...process.env, HOME: empty } });
  eq(run.status, 0, 'exit status');
  eq(run.stdout, 'payload from claude code', 'statusline output');
  cli('uninstall');
});

check('uninstall restores a statusline install did not understand', () => {
  const settingsFile = path.join(CONFIG, 'settings.json');
  const odd = { type: 'something-else', text: 'hand written' };
  fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: odd }, null, 2));
  cli('install');
  cli('uninstall');
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  eq(after.statusLine?.text, 'hand written', 'restored statusLine');
});

// --- the fast path ----------------------------------------------------------

check('gate.sh exits without starting node when nothing is wrong', () => {
  feed(20, 10);
  const res = spawnSync(path.join(BIN, 'gate.sh'), [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
    env,
    encoding: 'utf8',
  });
  eq(res.status, 0, 'exit status');
  eq(res.stdout, '', 'stdout');
});

check('gate.sh hands a real breach to the gate', () => {
  cli('on');
  feed(90, 10);
  const res = spawnSync(path.join(BIN, 'gate.sh'), [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    env,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(res.stdout);
  eq(parsed.continue, false, 'continue');
});

// --- the slash commands -----------------------------------------------------

// Claude Code registers a plugin command as `<plugin>:<file>`, and resolves
// `/cclimit go` by treating the first word after the plugin name as the file
// name. So every subcommand the docs and the breach message mention has to
// exist as its own file, and each file has to forward to the same binary.
check('every documented subcommand has a command file that forwards to it', () => {
  const dir = path.join(HERE, '..', 'commands');
  const documented = ['status', 'go', 'on', 'off', 'action', '5h', '7d', 'install', 'uninstall'];
  for (const name of documented) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) throw new Error(`no command file for /cclimit ${name}`);
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('${CLAUDE_PLUGIN_ROOT}/scripts/cclimit.mjs')) throw new Error(`${name}.md does not call the binary`);
    if (!text.includes(`cclimit.mjs" ${name} $ARGUMENTS`)) throw new Error(`${name}.md forwards the wrong subcommand`);
    if (!/^allowed-tools: Bash\(node:\*\)$/m.test(text)) throw new Error(`${name}.md is missing allowed-tools`);
  }
});

// The whole point is that a human decides whether to spend past the line. A
// command file the model can call on its own lets Claude lift its own brake —
// and the gate waves those calls through by design.
check('the model cannot invoke the commands that lift the limit', () => {
  const dir = path.join(HERE, '..', 'commands');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!/^disable-model-invocation: true$/m.test(text)) {
      throw new Error(`${file} is invocable by the model`);
    }
  }
});

// Every `/cclimit <x>` the plugin prints at the user is an escape hatch, so a
// missing command file there is a user with no way out.
check('every subcommand the plugin prints at the user has a command file', () => {
  feed(90, 10);
  const gate = spawnSync(path.join(BIN, 'gate.sh'), [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    env,
    encoding: 'utf8',
  });
  const printed = [cli('status'), JSON.parse(gate.stdout).stopReason].join('\n');
  const offered = new Set([...printed.matchAll(/\/cclimit ([a-z0-9]+)/g)].map((m) => m[1]));
  if (offered.size < 3) throw new Error(`expected several offers, saw: ${[...offered]}`);
  for (const name of offered) {
    if (!fs.existsSync(path.join(HERE, '..', 'commands', `${name}.md`))) {
      throw new Error(`the plugin offers /cclimit ${name} but ships no ${name}.md`);
    }
  }
});

// --- handing over to a newer install ---------------------------------------
//
// Claude Code resolves the plugin directory once per session, so without this a
// fix only reaches a running session after a restart.

const FAKE_VERSION = path.join(CONFIG, 'plugins', 'cache', 'market', 'cclimit', '9.9.9');
const FAKE_BIN = path.join(FAKE_VERSION, 'scripts');

// `layout` is which directory the planted copy lives in: bin/ up to 0.5.1,
// scripts/ after it. Both are real shapes to find in a plugin cache.
function plantNewer(file, body, { newer = true, layout = 'scripts' } = {}) {
  const dir = path.join(FAKE_VERSION, layout);
  fs.mkdirSync(dir, { recursive: true });
  // A copy is only trusted if it looks whole, so a plausible one needs the
  // module its real counterpart imports.
  fs.writeFileSync(path.join(dir, 'lib.mjs'), 'export const planted = true;\n');
  const target = path.join(dir, file);
  fs.writeFileSync(target, body, { mode: 0o755 });
  const own = fs.statSync(path.join(BIN, file)).mtime;
  const when = new Date(own.getTime() + (newer ? 60_000 : -60_000));
  fs.utimesSync(target, when, when);
  return target;
}

function unplant() {
  fs.rmSync(path.join(CONFIG, 'plugins'), { recursive: true, force: true });
}

check('a command hands over to the copy installed after it', () => {
  plantNewer('cclimit.mjs', "process.stdout.write('from the newer copy: ' + process.argv.slice(2).join(' ') + '\\n');\n");
  const text = cli('status');
  eq(text, 'from the newer copy: status\n', 'stdout');
  unplant();
});

check('an older copy left in the cache is never handed over to', () => {
  plantNewer('cclimit.mjs', "process.stdout.write('from the older copy\\n');\n", { newer: false });
  const text = cli('status');
  if (/older copy/.test(text)) throw new Error(`handed over to an older version: ${text}`);
  unplant();
});

check('handing over happens once and cannot recurse', () => {
  // A newer copy that would itself hand over, if the guard did not stop it.
  plantNewer('cclimit.mjs', "process.stdout.write((process.env.CCLIMIT_NO_FORWARD ? 'guarded' : 'unguarded') + '\\n');\n");
  eq(cli('status'), 'guarded\n', 'stdout');
  unplant();
});

// An update caught halfway is the realistic failure, and the escape hatches are
// the worst possible thing to lose to it.
check('a newer copy that does not parse is left alone', () => {
  plantNewer('cclimit.mjs', 'this file is not javascript at all\n');
  const text = cli('status');
  if (!/cclimit is/.test(text)) throw new Error(`no answer from the working copy: ${text}`);
  unplant();
});

check('a newer copy missing the module it imports is left alone', () => {
  plantNewer('cclimit.mjs', "process.stdout.write('from the half-installed copy\\n');\n");
  fs.rmSync(path.join(FAKE_BIN, 'lib.mjs'), { force: true });
  const text = cli('status');
  if (/half-installed/.test(text)) throw new Error(`handed over to a partial install: ${text}`);
  if (!/cclimit is/.test(text)) throw new Error(`no answer from the working copy: ${text}`);
  unplant();
});

check('a gate that does not parse is left alone', () => {
  feed(90, 10);
  plantNewer('gate.mjs', 'neither is this\n');
  const res = spawnSync(path.join(BIN, 'gate.sh'), [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    env,
    encoding: 'utf8',
  });
  eq(JSON.parse(res.stdout).continue, false, 'continue');
  if (!/90%/.test(JSON.parse(res.stdout).stopReason)) throw new Error(`no real decision: ${res.stdout}`);
  unplant();
});

check('the gate hands over to the decision the newer copy would make', () => {
  feed(90, 10);
  plantNewer('gate.mjs', "process.stdout.write(JSON.stringify({ continue: false, stopReason: 'newer gate' }));\n");
  const res = spawnSync(path.join(BIN, 'gate.sh'), [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    env,
    encoding: 'utf8',
  });
  eq(JSON.parse(res.stdout).stopReason, 'newer gate', 'stopReason');
  unplant();
});

check('the gate still says nothing when there is no breach to act on', () => {
  feed(20, 10);
  plantNewer('gate.mjs', "process.stdout.write(JSON.stringify({ continue: false, stopReason: 'newer gate' }));\n");
  const res = spawnSync(path.join(BIN, 'gate.sh'), [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    env,
    encoding: 'utf8',
  });
  eq(res.stdout, '', 'stdout');
  unplant();
});

// The executables moved out of bin/ in 0.5.2. Every version installed before
// that is still sitting in the cache with a working copy in it, and a session
// that started on one has to be able to hand over to the other in both
// directions.

check('a copy installed under the old bin/ layout is still handed over to', () => {
  plantNewer('cclimit.mjs', "process.stdout.write('from the bin copy\\n');\n", { layout: 'bin' });
  eq(cli('status'), 'from the bin copy\n', 'stdout');
  unplant();
});

check('the gate hands over to a newer copy left under the old bin/ layout', () => {
  feed(90, 10);
  plantNewer('gate.mjs', "process.stdout.write(JSON.stringify({ continue: false, stopReason: 'bin gate' }));\n", {
    layout: 'bin',
  });
  const res = spawnSync(path.join(BIN, 'gate.sh'), [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    env,
    encoding: 'utf8',
  });
  eq(JSON.parse(res.stdout).stopReason, 'bin gate', 'stopReason');
  unplant();
});

// An installed wrapper is a file and does not change when the plugin does, so
// the one thing in it that went stale with the move is repaired in place.

check('a statusline wrapper written before the move is repaired', () => {
  const wrapper = path.join(STATE, 'statusline-wrap.sh');
  fs.writeFileSync(
    wrapper,
    ['#!/bin/sh',
      'SINK=$(ls -1dt "$HOME"/.claude/plugins/cache/*/cclimit/*/bin/sink.mjs 2>/dev/null | head -1)',
      '[ -f "$SINK" ] || SINK=/somewhere/else/sink.mjs',
      'if [ -f "$SINK" ]; then',
      '  node "$SINK" | my-statusline --fancy',
      'else',
      '  cat | my-statusline --fancy',
      'fi',
      ''].join('\n'),
    { mode: 0o755 },
  );
  cli('status');
  const text = fs.readFileSync(wrapper, 'utf8');
  if (!text.includes('/cclimit/*/scripts/sink.mjs')) throw new Error(`lookup not repaired: ${text}`);
  if (!text.includes('/cclimit/*/bin/sink.mjs')) throw new Error(`old installs no longer found: ${text}`);
  if (!text.includes('my-statusline --fancy')) throw new Error(`statusline command lost: ${text}`);
  if (!text.includes('/somewhere/else/sink.mjs')) throw new Error(`fallback path lost: ${text}`);
  const again = fs.readFileSync(wrapper, 'utf8');
  cli('status');
  eq(fs.readFileSync(wrapper, 'utf8'), again, 'a repaired wrapper is left alone');
  fs.rmSync(wrapper, { force: true });
});

// Claude Code runs the statusline command by path. writeFileSync applies its
// `mode` only when it creates the file, so a wrapper that arrived without its
// executable bit — copied between machines, restored from an archive, checked
// out of a dotfiles repo — would keep losing it through every rewrite, and an
// unrunnable statusline is no collector and so no gate at all.
check('a rewritten wrapper gets its executable bit back', () => {
  const wrapper = path.join(STATE, 'statusline-wrap.sh');
  fs.writeFileSync(
    wrapper,
    ['#!/bin/sh',
      'SINK=$(ls -1dt "$HOME"/.claude/plugins/cache/*/cclimit/*/bin/sink.mjs 2>/dev/null | head -1)',
      '[ -f "$SINK" ] || SINK=/somewhere/else/sink.mjs',
      'echo',
      ''].join('\n'),
  );
  fs.chmodSync(wrapper, 0o644);
  cli('status');
  eq(fs.statSync(wrapper).mode & 0o111, 0o111, 'executable bits after the repair');
  fs.rmSync(wrapper, { force: true });

  // And the same on the path that writes a wrapper from scratch over one that
  // is already there.
  const settingsFile = path.join(CONFIG, 'settings.json');
  const saved = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  fs.writeFileSync(wrapper, '#!/bin/sh\necho\n');
  fs.chmodSync(wrapper, 0o644);
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }, null, 2));
  cli('install');
  eq(fs.statSync(wrapper).mode & 0o111, 0o111, 'executable bits after install');
  cli('uninstall');
  if (saved === null) fs.rmSync(settingsFile, { force: true });
  else fs.writeFileSync(settingsFile, saved);
});

// 0.1.1 wrote the lookup as the fallback half of a test rather than on a line
// of its own, so a repair that spans two lines would leave the second one
// running unconditionally and clear the pinned path it was meant to keep.
check('a wrapper from before the lookup moved onto its own line still works', () => {
  const wrapper = path.join(STATE, 'statusline-wrap.sh');
  fs.writeFileSync(
    wrapper,
    ['#!/bin/sh',
      "SINK='/somewhere/else/sink.mjs'",
      '[ -f "$SINK" ] || SINK=$(ls -1dt "$HOME"/.claude/plugins/cache/*/cclimit/*/bin/sink.mjs 2>/dev/null | head -1)',
      'if [ -f "$SINK" ]; then',
      '  node "$SINK" | my-statusline --fancy',
      'else',
      '  cat | my-statusline --fancy',
      'fi',
      ''].join('\n'),
    { mode: 0o755 },
  );
  cli('status');
  const text = fs.readFileSync(wrapper, 'utf8');
  if (!text.includes('/cclimit/*/scripts/sink.mjs')) throw new Error(`lookup not repaired: ${text}`);
  if (!/\[ -f "\$SINK" \] \|\| SINK=\$\(ls/.test(text)) throw new Error(`the test no longer guards the lookup: ${text}`);
  eq(spawnSync('sh', ['-n', wrapper]).status, 0, 'the repaired wrapper is valid shell');
  // The pinned path still wins when it is there, which is the whole point of
  // the shape this version wrote: run the two lookup lines and see what they
  // settle on.
  const pinned = path.join(STATE, 'pinned-sink.mjs');
  fs.writeFileSync(pinned, '');
  const lookup = text.split('\n').slice(1, 3).join('\n').replace('/somewhere/else/sink.mjs', pinned);
  const ran = spawnSync('sh', ['-c', `${lookup}\nprintf %s "$SINK"`]);
  eq(String(ran.stdout), pinned, 'the pinned collector still wins over the lookup');
  fs.rmSync(pinned, { force: true });
  fs.rmSync(wrapper, { force: true });
});

// --- where the window is heading -------------------------------------------

check('status projects where the window lands at the current rate', () => {
  ceilingOff();
  // A tenth of a point a minute, with an hour to run: 21% now, about 27% by
  // the time the window turns over.
  writeHistory(Array.from({ length: 11 }, (_, i) => ({ ts: NOW - (10 - i) * 60, five_hour: 20 + i / 10, seven_day: 10 })));
  feed(21, 10);
  const text = cli('status');
  if (!/at this rate about 27% by reset/.test(text)) throw new Error(`no projection in status: ${text}`);
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

check('a window on course to run out says so instead of a number', () => {
  ceilingOff();
  writeHistory(Array.from({ length: 11 }, (_, i) => ({ ts: NOW - (10 - i) * 60, five_hour: 70 + i, seven_day: 10 })));
  feed(79, 10);
  const text = cli('status');
  if (!/runs out before it resets/.test(text)) throw new Error(`no warning in status: ${text}`);
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

check('the 7-day window gets no projection, because the rate cannot support one', () => {
  ceilingOff();
  writeHistory(Array.from({ length: 11 }, (_, i) => ({ ts: NOW - (10 - i) * 60, five_hour: 20 + i / 10, seven_day: 10 + i / 10 })));
  feed(21, 11);
  const text = cli('status');
  const projections = text.match(/at this rate/g) || [];
  if (projections.length !== 1) throw new Error(`expected one projection, got ${projections.length}: ${text}`);
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

check('status draws the last stretch of burn as a sparkline', () => {
  ceilingOff();
  // Half an hour of readings with the spending bunched in the middle. Whole
  // percentages, because that is what Claude Code publishes.
  writeHistory(
    Array.from({ length: 31 }, (_, i) => ({
      ts: NOW - (30 - i) * 60,
      five_hour: 40 + (i < 10 ? Math.round(i * 0.1) : i < 20 ? Math.round(1 + (i - 10) * 0.5) : Math.round(6 + (i - 20) * 0.1)),
      seven_day: 10,
    }))
  );
  feed(47, 10);
  const text = cli('status');
  const line = text.split('\n').find((l) => /last \d+m/.test(l));
  if (!line) throw new Error(`no span label on the sparkline: ${text}`);
  const spark = line.match(/[\u2581-\u2588]{30}/);
  if (!spark) throw new Error(`no sparkline in status: ${text}`);
  // The busy middle has to stand above the quiet ends, or the chart is drawn
  // from levels rather than from what each stretch cost. Which cell the peak
  // lands in shifts with however long the run took to get here, so this asks
  // only that it is somewhere in the middle and that both ends are below it.
  const cells = [...spark[0]].map((c) => c.codePointAt(0) - 0x2580);
  const top = Math.max(...cells);
  const at = cells.indexOf(top);
  if (at < 3 || at > 26) throw new Error(`the peak is at the edge: ${spark[0]}`);
  if (cells[0] >= top || cells[cells.length - 1] >= top) {
    throw new Error(`the quiet stretches are not the low ones: ${spark[0]}`);
  }
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

check('a staircase of whole percentages is not drawn as a comb', () => {
  ceilingOff();
  // Steady work at about a third of a point a minute: the number moves once
  // every three minutes and sits still in between.
  writeHistory(
    Array.from({ length: 91 }, (_, i) => ({
      ts: NOW - (90 - i) * 20,
      five_hour: 40 + Math.floor(i / 9),
      seven_day: 10,
    }))
  );
  feed(50, 10);
  const text = cli('status');
  const spark = text.match(/[\u2581-\u2588]{30}/);
  if (!spark) throw new Error(`no sparkline in status: ${text}`);
  const cells = [...spark[0]].map((c) => c.codePointAt(0) - 0x2580);
  const gaps = cells.filter((c) => c === 1).length;
  if (gaps > 2) throw new Error(`steady work drawn as ${gaps} empty cells: ${spark[0]}`);
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

check('one step in the whole trail is a fact, not a shape', () => {
  ceilingOff();
  writeHistory(
    Array.from({ length: 60 }, (_, i) => ({
      ts: NOW - (60 - i) * 20,
      five_hour: i < 30 ? 3 : 4,
      seven_day: 10,
    }))
  );
  feed(4, 10);
  const text = cli('status');
  if (/last \d+m/.test(text)) throw new Error(`a single step was charted: ${text}`);
  fs.rmSync(path.join(STATE, 'history.json'), { force: true });
});

// --- a window that has reset -----------------------------------------------

function feedWindows(five, fiveReset, seven, sevenReset) {
  return run(
    'sink.mjs',
    [],
    JSON.stringify({
      model: { id: 'claude-opus-5', display_name: 'Opus 5' },
      session_id: 'test-session',
      rate_limits: {
        five_hour: { used_percentage: five, resets_at: fiveReset },
        seven_day: { used_percentage: seven, resets_at: sevenReset },
      },
    })
  );
}

function resetResume() {
  fs.rmSync(path.join(STATE, 'resume.json'), { force: true });
  fs.rmSync(path.join(STATE, 'breach.json'), { force: true });
  // These scenarios move the reset time forward on purpose, and a reading that
  // arrives with an earlier one is now treated as stale. Start each of them
  // without a stored reading rather than against the last one left behind.
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  resetNotices();
}

check('a window that was full says so when it resets', () => {
  resetResume();
  feedWindows(85, NOW + 60, 10, NOW + 86400);
  feedWindows(4, NOW + 3600, 10, NOW + 86400);
  eq(breachFile()?.kind, 'resume', 'breach kind');

  const res = gate('UserPromptSubmit', { prompt: 'back to the refactor' });
  if (res.decision) throw new Error(`a reset blocked a prompt: ${JSON.stringify(res)}`);
  if (!/window reset/.test(res.systemMessage)) throw new Error(`no reset in the message: ${res.systemMessage}`);
  if (!/85%/.test(res.systemMessage)) throw new Error(`no before-and-after: ${res.systemMessage}`);
  eq(breachFile(), null, 'breach file');
});

check('the reset is announced once, not on every prompt after it', () => {
  resetResume();
  feedWindows(85, NOW + 60, 10, NOW + 86400);
  feedWindows(4, NOW + 3600, 10, NOW + 86400);
  gate('UserPromptSubmit', { prompt: 'carry on' });
  feedWindows(5, NOW + 3600, 10, NOW + 86400);
  eq(breachFile(), null, 'breach file');
  eq(gate('UserPromptSubmit', { prompt: 'carry on' }), null, 'second prompt');
});

check('a window nobody was waiting on resets quietly', () => {
  resetResume();
  feedWindows(20, NOW + 60, 10, NOW + 86400);
  feedWindows(2, NOW + 3600, 10, NOW + 86400);
  eq(breachFile(), null, 'breach file');
});

check('the next window to fill up is announced in its turn', () => {
  resetResume();
  feedWindows(85, NOW + 60, 10, NOW + 86400);
  feedWindows(4, NOW + 3600, 10, NOW + 86400);
  gate('UserPromptSubmit', { prompt: 'carry on' });
  feedWindows(86, NOW + 3600, 10, NOW + 86400);
  feedWindows(3, NOW + 7200, 10, NOW + 86400);
  eq(breachFile()?.kind, 'resume', 'breach kind');
  gate('UserPromptSubmit', { prompt: 'carry on' });
  resetResume();
});

check('a window already back over the line is not announced as free', () => {
  resetResume();
  feedWindows(85, NOW + 60, 10, NOW + 86400);
  // A new window that filled straight back up: the line has its own thing to
  // say about that, and the reset is no longer the news.
  feedWindows(90, NOW + 3600, 10, NOW + 86400);
  eq(breachFile()?.kind, 'line', 'breach kind');
});

check('an unreadable resume file is a missed sentence, never a block', () => {
  resetResume();
  feedWindows(85, NOW + 60, 10, NOW + 86400);
  feedWindows(4, NOW + 3600, 10, NOW + 86400);
  eq(breachFile()?.kind, 'resume', 'breach kind');

  // Corrupted after it was armed and before anyone read it: the sentence is
  // lost, which is the whole cost of it.
  fs.writeFileSync(path.join(STATE, 'resume.json'), 'not json {{');
  feedWindows(5, NOW + 3600, 10, NOW + 86400);
  eq(breachFile(), null, 'breach file');
  eq(gate('UserPromptSubmit', { prompt: 'carry on' }), null, 'prompt');
  resetResume();
});

check('a resume file that cannot be parsed is rewritten rather than kept', () => {
  resetResume();
  fs.writeFileSync(path.join(STATE, 'resume.json'), 'not json {{');
  feedWindows(85, NOW + 60, 10, NOW + 86400);
  feedWindows(4, NOW + 3600, 10, NOW + 86400);
  eq(breachFile()?.kind, 'resume', 'breach kind');
  resetResume();
});

// --- running cheaper instead of stopping ------------------------------------

function downgradeOff() {
  cli('downgrade', 'off');
  ceilingOff();
  fs.rmSync(path.join(STATE, 'limits.json'), { force: true });
  resetNotices();
}

check('downgrading is off unless it is asked for', () => {
  const config = JSON.parse(cli('status', '--json')).config;
  eq(config.downgrade, null, 'downgrade');
});

check('a subagent past the line is moved onto the cheaper model', () => {
  downgradeOff();
  cli('downgrade', 'sonnet');
  feed(85, 10);
  const res = gate('PreToolUse', { tool_name: 'Task', tool_input: { prompt: 'go and read the tests', subagent_type: 'general-purpose' } });
  eq(res.hookSpecificOutput?.updatedInput?.model, 'sonnet', 'model');
  eq(res.hookSpecificOutput?.updatedInput?.prompt, 'go and read the tests', 'prompt');
  if (res.continue === false) throw new Error(`downgrading stopped the turn: ${JSON.stringify(res)}`);
  downgradeOff();
});

check('a subagent already on a cheaper model is left alone', () => {
  downgradeOff();
  cli('downgrade', 'sonnet');
  feed(85, 10);
  eq(gate('PreToolUse', { tool_name: 'Task', tool_input: { prompt: 'x', model: 'haiku' } }), null, 'response');
  downgradeOff();
});

check('an ordinary tool call past the line runs untouched while downgrading', () => {
  downgradeOff();
  cli('downgrade', 'sonnet');
  feed(85, 10);
  eq(gate('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null, 'response');
  downgradeOff();
});

check('the prompt is told once that the session keeps its own model', () => {
  downgradeOff();
  cli('downgrade', 'sonnet');
  feed(85, 10);
  const first = gate('UserPromptSubmit', { prompt: 'keep going' });
  if (first.decision) throw new Error(`downgrading blocked a prompt: ${JSON.stringify(first)}`);
  if (!/\/model sonnet/.test(first.systemMessage)) throw new Error(`no way to move the session: ${first.systemMessage}`);
  feed(86, 10);
  eq(gate('UserPromptSubmit', { prompt: 'and again' }), null, 'second prompt');
  downgradeOff();
});

check('a ceiling still stops everything while downgrading', () => {
  downgradeOff();
  cli('downgrade', 'sonnet');
  cli('ceiling', '5h', '95');
  feed(96, 10);
  const res = gate('PreToolUse', { tool_name: 'Task', tool_input: { prompt: 'x' } });
  eq(res.continue, false, 'continue');
  downgradeOff();
});

check('downgrade takes a model it knows or nothing at all', () => {
  downgradeOff();
  const res = run('cclimit.mjs', ['downgrade', 'gpt']);
  if (res.status === 0) throw new Error('accepted a model it cannot set');
  eq(JSON.parse(cli('status', '--json')).config.downgrade, null, 'downgrade');
});

// --- every setting on one screen --------------------------------------------

check('the config screen names every knob and how to turn it', () => {
  const text = cli('config');
  for (const row of ['Enabled', 'At the line', 'Downgrade instead of stopping', 'Line (5h)', 'Ceiling (7d)', 'Heads-up (5h)', 'Snoozed until']) {
    if (!text.includes(row)) throw new Error(`no "${row}" row: ${text}`);
  }
  for (const how of ['/cclimit action', '/cclimit ceiling 7d', '/cclimit notice 5h', '/cclimit downgrade']) {
    if (!text.includes(how)) throw new Error(`no command for a row: ${how}`);
  }
});

check('the config file is still one command away', () => {
  const text = cli('config', 'path').trim();
  if (!text.endsWith('config.json')) throw new Error(`not a config path: ${text}`);
});

fs.rmSync(ROOT, { recursive: true, force: true });

if (failures.length) {
  process.stderr.write(`${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`cclimit: ${passed} checks passed\n`);
