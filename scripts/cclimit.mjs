#!/usr/bin/env node
// The command surface behind /cclimit. Everything the user can change lives in
// one small JSON file; this reads and writes it, and wires the collector into
// the statusline.
//
//   cclimit status              what the limits are and where usage stands
//   cclimit 5h 85               stop at 85% of the 5-hour window
//   cclimit 7d 90               stop at 90% of the 7-day window
//   cclimit ceiling 5h 99       the number /cclimit go cannot lift
//   cclimit notice 5h 75        a heads-up before the line, said once per window
//   cclimit action stop|ask|warn
//   cclimit downgrade sonnet|haiku|off   run subagents cheaper instead of stopping
//   cclimit config              every setting and the command that changes it
//   cclimit go                  keep going until the window resets
//   cclimit on | off
//   cclimit install | uninstall

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_FILE,
  SETTINGS_FILE,
  STATE_DIR,
  WRAP_FILE,
  WINDOWS,
  loadConfig,
  saveConfig,
  loadLimits,
  loadBreach,
  loadHistory,
  burnRate,
  minutesTo,
  projectedAtReset,
  sparkline,
  DOWNGRADE_MODELS,
  clearBreach,
  evaluate,
  pct,
  untilReset,
  localTime,
  newerSelf,
  rearmNotice,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SINK = path.join(HERE, 'sink.mjs');

// A session pins the plugin directory it started with, so without this an
// update only reaches the commands after a restart — and the command that was
// just fixed keeps printing the bug.
const newer = newerSelf(HERE, 'cclimit.mjs');
if (newer) {
  const relay = spawnSync(process.execPath, [newer, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, CCLIMIT_NO_FORWARD: '1' },
  });
  // Anything that stopped the newer copy from running at all leaves this one to
  // do the work rather than failing in front of the user.
  if (!relay.error) process.exit(relay.status ?? 0);
}
const args = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');
const now = Math.floor(Date.now() / 1000);

function out(text) {
  process.stdout.write(text.replace(/\n*$/, '\n'));
}

function die(text) {
  process.stderr.write(text.replace(/\n*$/, '\n'));
  process.exit(1);
}

function windowKey(token) {
  const t = String(token).toLowerCase();
  if (['5h', 'five_hour', '5', 'hour', 'session'].includes(t)) return 'five_hour';
  if (['7d', 'seven_day', '7', 'week', 'weekly'].includes(t)) return 'seven_day';
  return null;
}

function currentUsage() {
  const stored = loadLimits();
  if (!stored?.rate_limits) return null;
  return { rateLimits: stored.rate_limits, ts: stored.ts ?? 0 };
}

// A 24-cell gauge with a tick where the work stops, so the shape of the window
// reads before any of the numbers do. The tick sits between cells rather than
// on one, so it never costs a cell of the reading it marks.
const BAR_CELLS = 24;

function bar(used, line, ceiling) {
  const cells = [];
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((used / 100) * BAR_CELLS)));
  for (let i = 0; i < BAR_CELLS; i += 1) cells.push(i < filled ? '\u2588' : '\u2591');

  // Ceiling first: where both exist, the ceiling is the one that actually stops
  // everything, and two ticks in 24 cells is noise rather than information.
  const stop = typeof ceiling === 'number' ? ceiling : typeof line === 'number' ? line : null;
  if (stop !== null) {
    const at = Math.max(0, Math.min(BAR_CELLS, Math.round((stop / 100) * BAR_CELLS)));
    cells.splice(at, 0, '\u2502');
  }
  return cells.join('');
}

function status() {
  const config = loadConfig();
  const usage = currentUsage();
  const breach = loadBreach();
  const history = loadHistory();

  if (asJson) {
    out(JSON.stringify({ config, usage, breach }, null, 2));
    return;
  }

  const lines = [];
  const state = !config.enabled
    ? 'off'
    : config.snoozeUntil && now < config.snoozeUntil
      ? `snoozed until ${localTime(config.snoozeUntil)} (${untilReset(config.snoozeUntil)} left)`
      : `on \u00b7 action: ${config.downgrade ? `downgrade to ${config.downgrade}` : config.action}`;
  lines.push(`cclimit is ${state}`);

  for (const [key, meta] of Object.entries(WINDOWS)) {
    const win = usage?.rateLimits?.[key];
    const limit = config.thresholds[key];
    lines.push('');
    if (!win || typeof win.used_percentage !== 'number') {
      lines.push(`  ${meta.label}  no data yet  (stop at ${limit}%)`);
      continue;
    }
    const ceiling = config.ceilings[key];
    const notice = config.notices[key];
    const over = typeof ceiling === 'number' && win.used_percentage >= ceiling;
    const flag = over ? '  <- at your ceiling' : win.used_percentage >= limit ? '  <- over your line' : '';

    // The bar carries the two numbers that matter at a glance: how full the
    // window is, and where in it the work stops. Everything else is words
    // underneath, because words are what you read second.
    lines.push(`  ${meta.label}  ${bar(win.used_percentage, limit, ceiling)}  ${pct(win.used_percentage)} used${flag}`);

    const marks = [`stop at ${limit}%`];
    if (typeof ceiling === 'number') marks.push(`ceiling ${ceiling}%`);
    marks.push(typeof notice === 'number' ? `notice at ${notice}%` : 'no notice');
    lines.push(`      ${marks.join(' \u00b7 ')}`);

    // The rate is only worth printing where it answers something: how long the
    // room between here and the ceiling actually lasts.
    const rate = burnRate(history, key, now);
    const tail = [];
    // A rate that prints as 0.0%/min is a rate with nothing to say, and the
    // number of minutes to a target the window will reset long before is worse
    // than nothing: it invites planning around a wall that is never reached.
    if (rate && rate >= 0.05) {
      const target = typeof ceiling === 'number' ? ceiling : 100;
      const minutes = minutesTo(win.used_percentage, target, rate);
      const left = Number.isFinite(win.resets_at) ? (win.resets_at - now) / 60 : null;
      const reachable = minutes !== null && (left === null || minutes <= left);
      const eta = minutes === 0 ? ' — already there' : reachable ? ` — ${target}% in about ${minutes}m` : '';
      tail.push(`climbing ${rate.toFixed(1)}%/min${eta}`);
    }
    const at = localTime(win.resets_at);
    if (at) tail.push(`resets ${at} (in ${untilReset(win.resets_at)})`);
    if (tail.length) lines.push(`      ${tail.join(' \u00b7 ')}`);

    // Where the window lands if the current pace holds. Said as a projection
    // rather than a fact, because it is one — and never for a reset far enough
    // away that the pace behind it has stopped meaning anything.
    const projected = projectedAtReset(win.used_percentage, win.resets_at, rate, now);
    if (projected !== null) {
      lines.push(
        `      ${projected >= 100 ? 'at this rate the window runs out before it resets' : `at this rate about ${Math.round(projected)}% by reset`}`
      );
    }

    // The shape of the spending behind the number: where it was flat, where it
    // was not. Drawn only when there is enough trail to draw.
    const spark = sparkline(history, key, now);
    if (spark) lines.push(`      last ${spark.minutes}m  ${spark.text}`);
  }

  if (!usage) {
    lines.push('');
    lines.push('No usage data recorded. Either the collector is not installed');
    lines.push('(run: /cclimit install) or this account has no subscription');
    lines.push('windows to report — API key, Bedrock and Vertex all leave them empty.');
  } else if (now - usage.ts > 120) {
    lines.push('');
    lines.push(`Last reading is ${untilReset(now + (now - usage.ts))} old — the statusline may not be rendering.`);
  }

  // Only a line and a ceiling hold anything. A heads-up and a reset notice ride
  // in the same file, and reporting either of them here would claim a block
  // that is not happening.
  if (breach && (breach.kind === 'line' || breach.kind === 'ceiling')) {
    lines.push('');
    const what = breach.kind === 'ceiling' ? 'ceiling' : 'line';
    lines.push(`Currently holding: ${breach.label} at ${pct(breach.used_percentage)}, against your ${what} of ${breach.threshold}%.`);
    lines.push(
      breach.kind === 'ceiling'
        ? `A ceiling is not snoozeable. Raise it with /cclimit ceiling ${breach.label} <percent> or remove it with /cclimit ceiling ${breach.label} off.`
        : 'Run /cclimit go to continue until the window resets.'
    );
  }
  out(lines.join('\n'));
}

function setThreshold(key, valueRaw) {
  const value = Number(valueRaw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) die(`Threshold must be a number between 1 and 100, got: ${valueRaw}`);
  const config = loadConfig();
  const ceiling = config.ceilings[key];
  // A line at or above the ceiling can never fire: the ceiling stops everything
  // first. Silently keeping both would leave someone believing in a line that
  // does nothing.
  if (typeof ceiling === 'number' && value >= ceiling) {
    die(
      `cclimit: a line at ${value}% would never fire — your ${WINDOWS[key].label} ceiling is ${ceiling}% and stops first.\n` +
        `Raise the ceiling (/cclimit ceiling ${WINDOWS[key].label} <percent>) or set a lower line.`
    );
  }
  const notice = config.notices[key];
  // A heads-up at or above the line arrives with the stop, or after it, which
  // is exactly the thing it exists to avoid.
  if (typeof notice === 'number' && value <= notice) {
    die(
      `cclimit: a line at ${value}% is at or below your ${WINDOWS[key].label} notice of ${notice}%, ` +
        `so the heads-up would arrive with the stop.\n` +
        `Move the notice down (/cclimit notice ${WINDOWS[key].label} <percent>) or set a higher line.`
    );
  }
  config.thresholds[key] = value;
  // A new line the current usage clears makes the old snooze meaningless.
  config.snoozeUntil = null;
  saveConfig(config);
  refreshBreach(config);
  const guard = typeof ceiling === 'number' ? ` Ceiling stays at ${ceiling}%.` : '';
  out(`cclimit: ${WINDOWS[key].label} window now stops at ${value}%.${guard}`);
}

// The ceiling is the number /cclimit go cannot lift, so it is also the only
// number in here that is worth setting and then forgetting.
function setCeiling(key, valueRaw) {
  const config = loadConfig();
  const token = String(valueRaw ?? '').toLowerCase();

  if (['off', 'none', 'no', 'remove', '0'].includes(token)) {
    config.ceilings[key] = null;
    saveConfig(config);
    refreshBreach(config);
    out(`cclimit: ${WINDOWS[key].label} ceiling removed. /cclimit go now runs to 100% again.`);
    return;
  }

  const value = Number(valueRaw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    die(`Ceiling must be a number between 1 and 100, or "off", got: ${valueRaw}`);
  }
  const line = config.thresholds[key];
  if (typeof line === 'number' && value <= line) {
    die(
      `cclimit: a ceiling at ${value}% is at or below your ${WINDOWS[key].label} line of ${line}%, which leaves the line no room.\n` +
        `Set the ceiling above the line, or lower the line first: /cclimit ${WINDOWS[key].label} <percent>`
    );
  }
  config.ceilings[key] = value;
  saveConfig(config);
  refreshBreach(config);
  out(
    `cclimit: ${WINDOWS[key].label} ceiling set to ${value}%. Work continues past ${line}% once you say so, ` +
      `and stops at ${value}% whatever you say.`
  );
}

// The heads-up. Unlike the line and the ceiling this decides nothing — it is
// the one number here whose whole job is to be said out loud and then get out
// of the way.
function setNotice(key, valueRaw) {
  const config = loadConfig();
  const token = String(valueRaw ?? '').toLowerCase();

  if (['off', 'none', 'no', 'remove', '0'].includes(token)) {
    config.notices[key] = null;
    saveConfig(config);
    rearmNotice(key);
    refreshBreach(config);
    out(`cclimit: ${WINDOWS[key].label} notice removed. The line is the first you will hear of it again.`);
    return;
  }

  const value = Number(valueRaw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    die(`Notice must be a number between 1 and 100, or "off", got: ${valueRaw}`);
  }
  const line = config.thresholds[key];
  if (typeof line === 'number' && value >= line) {
    die(
      `cclimit: a notice at ${value}% is at or above your ${WINDOWS[key].label} line of ${line}%, ` +
        `so it would arrive with the stop rather than before it.\n` +
        `Set it below the line, or raise the line first: /cclimit ${WINDOWS[key].label} <percent>`
    );
  }
  config.notices[key] = value;
  saveConfig(config);
  // Moving the number is a new question, so the old answer stops counting and
  // the current window gets to say it again.
  rearmNotice(key);
  refreshBreach(config);
  out(
    `cclimit: ${WINDOWS[key].label} notice set to ${value}%. You will hear about it once per window, ` +
      `nothing will be blocked, and work still stops at ${line}%.`
  );
}

function setAction(value) {
  const allowed = ['stop', 'ask', 'warn'];
  if (!allowed.includes(value)) die(`Action must be one of: ${allowed.join(', ')}`);
  const config = loadConfig();
  config.action = value;
  saveConfig(config);
  const what = {
    stop: 'halt the turn and tell you why',
    ask: 'route the tool call to the permission prompt (it asks again on each call)',
    warn: 'let everything run and just say something',
  }[value];
  out(`cclimit: on a breach it will now ${what}.`);
}

// How loud a stop is. Only tool calls ring it: a blocked prompt is read a
// second after it was typed, and nobody needs a bell for that.
function setAlert(valueRaw) {
  const value = String(valueRaw || '').toLowerCase();
  const allowed = ['off', 'bell', 'notify'];
  if (!allowed.includes(value)) die(`Alert must be one of: ${allowed.join(', ')}`);
  const config = loadConfig();
  config.alert = value === 'off' ? null : value;
  saveConfig(config);
  const what = {
    off: 'say nothing to the terminal',
    bell: 'ring the terminal bell',
    notify: 'ring the bell and raise a desktop notification where your terminal supports one',
  }[value];
  out(`cclimit: when it interrupts a tool call it will now ${what}.`);
}

// Keep the breach file honest after a config change, instead of waiting for the
// next statusline render to catch up.
// Off by default and stays off unless asked for by name: this is the one
// setting that changes what the work is done by rather than whether it is done.
function setDowngrade(valueRaw) {
  const value = String(valueRaw || '').toLowerCase();
  const config = loadConfig();

  if (value === 'off' || value === 'none' || value === 'stop') {
    config.downgrade = null;
    saveConfig(config);
    out(`cclimit: downgrade off. The line does what "action" says again: ${config.action}.`);
    return;
  }

  if (!DOWNGRADE_MODELS.includes(value)) {
    die(`Downgrade takes ${DOWNGRADE_MODELS.join(' or ')}, or off. Got: ${valueRaw ?? ''}`);
  }

  config.downgrade = value;
  saveConfig(config);
  out(
    `cclimit: past your line, subagents will run on ${value} instead of stopping. ` +
      `Your own session keeps whatever /model says \u2014 nothing here can change that. ` +
      `A ceiling still stops everything.`
  );
}

function refreshBreach(config) {
  const usage = currentUsage();
  const breach = usage ? evaluate(usage.rateLimits, config) : null;
  if (breach) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'breach.json'), JSON.stringify(breach) + '\n');
  } else {
    clearBreach();
  }
}

function go() {
  const config = loadConfig();
  const breach = loadBreach();
  const usage = currentUsage();

  // A reset time that has already passed is no reprieve at all: the snooze
  // expires the moment it is written, the gate stops the very next tool call,
  // and the sentence printed here promises a stand-down that never happened.
  // The breach file is written by the collector against the reading at the
  // time, so a session that sat idle through a rollover has one naming a
  // window that is already over. Only a time still ahead of us is an answer.
  const ahead = (t) => (typeof t === 'number' && t > now ? t : null);

  let until = ahead(breach?.resets_at);
  if (!until && usage) {
    const resets = Object.keys(WINDOWS)
      .map((k) => ahead(usage.rateLimits[k]?.resets_at))
      .filter(Boolean);
    until = resets.length ? Math.min(...resets) : null;
  }
  config.snoozeUntil = until ?? now + 3600;
  saveConfig(config);
  clearBreach();
  // What a snooze does not cover is the part worth repeating: someone reaching
  // for `go` is reaching for "carry on", and needs to know where that ends.
  const caps = Object.entries(WINDOWS)
    .filter(([key]) => typeof config.ceilings[key] === 'number')
    .map(([key, meta]) => `${meta.label} ${config.ceilings[key]}%`);
  const guard = caps.length
    ? ` Your ceiling still stands (${caps.join(', ')}) and this does not lift it.`
    : ` Usage past your line from here on is on you.`;
  out(
    `cclimit: standing down until ${localTime(config.snoozeUntil)} (${untilReset(config.snoozeUntil)}).` +
      `${guard} /cclimit on to reinstate it sooner.`
  );
}

function toggle(enabled) {
  const config = loadConfig();
  config.enabled = enabled;
  if (enabled) config.snoozeUntil = null;
  saveConfig(config);
  if (enabled) refreshBreach(config);
  else clearBreach();
  out(enabled ? 'cclimit: back on.' : 'cclimit: off. Nothing will be blocked until /cclimit on.');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The two lines of the wrapper that find the collector. Kept apart from the
// rest of it because a wrapper already on disk has to be repaired to them, and
// a copy of them that drifts would repair it to the wrong thing.
// One line, and no helper variable, because this same string is spliced into
// wrappers written by earlier versions and they did not all put the lookup in
// the same place: 0.1.1 wrote it as the fallback half of `[ -f "$SINK" ] || …`,
// where a second line would land outside the test and run unconditionally.
const SINK_LOOKUP =
  'SINK=$(ls -1dt "$HOME"/.claude/plugins/cache/*/cclimit/*/scripts/sink.mjs "$HOME"/.claude/plugins/cache/*/cclimit/*/bin/sink.mjs 2>/dev/null | head -1)';

// What 0.5.1 and earlier wrote there, when the executables lived in bin/.
const SINK_LOOKUP_BIN =
  'SINK=$(ls -1dt "$HOME"/.claude/plugins/cache/*/cclimit/*/bin/sink.mjs 2>/dev/null | head -1)';

// An installed wrapper is a file, not code, so it does not change when the
// plugin updates: one written before the move goes on finding the collector
// under bin/, and an old version left in the cache is exactly where it finds
// one. Nothing breaks loudly — the collector simply stays the old collector
// for good. Only the lookup is rewritten, so whatever statusline command the
// user had wrapped around it is left as it is.
function healWrapper() {
  let text;
  try {
    text = fs.readFileSync(WRAP_FILE, 'utf8');
  } catch {
    return;
  }
  if (!text.includes(SINK_LOOKUP_BIN)) return;
  try {
    fs.writeFileSync(WRAP_FILE, text.replace(SINK_LOOKUP_BIN, SINK_LOOKUP), { mode: 0o755 });
  } catch {
    // A statusline running the old collector is a much smaller problem than a
    // command that refuses to answer, so a wrapper that cannot be written is
    // left alone.
  }
}

// The wrapper cannot hard-code the path to the collector: installing a plugin
// puts it in a directory named after its version, so `claude plugin update`
// both moves the collector out from under a path recorded today and leaves the
// old version sitting there to be found. So the most recently installed copy
// in the plugin cache wins, the path recorded at install time is the fallback
// for a collector that lives outside the cache, and passing stdin straight
// through is the answer when neither finds anything — an update must never be
// able to leave someone with no statusline at all.
function wrapperScript(downstream) {
  const collector = downstream ? `node "$SINK" | ${downstream}` : 'node "$SINK" --render';
  const passthrough = downstream ? `cat | ${downstream}` : 'echo';
  return `#!/bin/sh
# Generated by cclimit install: the cclimit collector piped in front of the
# statusline command that was here before. The collector copies stdin through
# untouched. Remove it with /cclimit uninstall, which also restores
# settings.json.
#
# The collector is looked up rather than fixed in place, because each version of
# a plugin is installed into a directory of its own: the newest one is the one
# to run, and the path below is only for a copy kept outside the plugin cache.
# If neither can be found, the statusline runs without the collector.
${SINK_LOOKUP}
[ -f "$SINK" ] || SINK=${shellQuote(SINK)}
if [ -f "$SINK" ]; then
  ${collector}
else
  ${passthrough}
fi
`;
}

function install() {
  const settings = readSettings();
  const config = loadConfig();
  const existing = settings.statusLine;

  if (existing?.command === WRAP_FILE || existing?.command?.includes('cclimit')) {
    out('cclimit: the collector is already in your statusline. Nothing to do.');
    return;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const backup = `${SETTINGS_FILE}.cclimit-backup`;
  if (fs.existsSync(SETTINGS_FILE) && !fs.existsSync(backup)) fs.copyFileSync(SETTINGS_FILE, backup);

  // Whatever was there — a command, something malformed, or nothing — is what
  // uninstall has to put back, so record it before touching anything.
  config.originalStatusLine = existing ?? null;

  // Keep the user's statusline exactly as it was and put the collector in front
  // of it. It copies stdin through untouched, so the visible result is
  // identical to before.
  const downstream = existing?.type === 'command' && existing.command ? existing.command : null;
  fs.writeFileSync(WRAP_FILE, wrapperScript(downstream), { mode: 0o755 });
  settings.statusLine = downstream
    ? { ...existing, command: WRAP_FILE }
    : { type: 'command', command: WRAP_FILE, padding: 0 };

  // The gates treat a reading older than maxStaleSeconds as no reading at all,
  // so the statusline has to actually re-render on a timer for this to work.
  if (typeof settings.statusLine.refreshInterval !== 'number' || settings.statusLine.refreshInterval > 30) {
    settings.statusLine.refreshInterval = 10;
  }

  writeSettings(settings);
  saveConfig(config);
  out(
    [
      'cclimit: collector installed.',
      existing ? `Your statusline command was kept and now runs behind ${WRAP_FILE}.` : 'A minimal usage statusline was added.',
      `settings.json backed up to ${backup}.`,
      '',
      `Stopping at ${config.thresholds.five_hour}% of the 5-hour window and ${config.thresholds.seven_day}% of the 7-day one.`,
      'Usage readings start arriving on the next statusline render.',
    ].join('\n')
  );
}

function uninstall() {
  const settings = readSettings();
  const config = loadConfig();

  if (config.originalStatusLine) settings.statusLine = config.originalStatusLine;
  else if (settings.statusLine?.command?.includes('cclimit')) delete settings.statusLine;

  writeSettings(settings);
  try {
    fs.unlinkSync(WRAP_FILE);
  } catch {
    /* nothing to remove */
  }
  config.originalStatusLine = null;
  saveConfig(config);
  clearBreach();
  out('cclimit: collector removed and your statusline restored. The plugin itself is still installed; /cclimit install puts it back.');
}

// Every knob in one screen, with the command that turns each one. A plugin
// command runs without a terminal of its own, so the arrow-key settings screen
// Claude Code has for itself cannot exist here; a printed table can, and it has
// the advantage of showing what to type rather than hiding it behind a keypress.
function configTable() {
  const config = loadConfig();
  const off = '\u2014';

  const rows = [
    ['Enabled', String(config.enabled), '/cclimit on \u00b7 /cclimit off'],
    ['At the line', config.action, '/cclimit action stop|ask|warn'],
    ['Downgrade instead of stopping', config.downgrade || 'off', `/cclimit downgrade ${DOWNGRADE_MODELS.join('|')}|off`],
    ['Alert on a stop', config.alert || 'off', '/cclimit alert bell|notify|off'],
    [null, null, null],
  ];

  for (const [key, meta] of Object.entries(WINDOWS)) {
    const line = config.thresholds[key];
    const ceiling = config.ceilings[key];
    const notice = config.notices[key];
    rows.push([`Line (${meta.label})`, typeof line === 'number' ? `${line}%` : off, `/cclimit ${meta.flag} <percent>`]);
    rows.push([
      `Ceiling (${meta.label})`,
      typeof ceiling === 'number' ? `${ceiling}%` : 'off',
      `/cclimit ceiling ${meta.flag} <percent>|off`,
    ]);
    rows.push([
      `Heads-up (${meta.label})`,
      typeof notice === 'number' ? `${notice}%` : 'off',
      `/cclimit notice ${meta.flag} <percent>|off`,
    ]);
    rows.push([null, null, null]);
  }

  const snoozed = config.snoozeUntil && now < config.snoozeUntil;
  rows.push([
    'Snoozed until',
    snoozed ? `${localTime(config.snoozeUntil)} (${untilReset(config.snoozeUntil)} left)` : off,
    snoozed ? '/cclimit on to end it early' : '/cclimit go',
  ]);

  const width = Math.max(...rows.filter((r) => r[0]).map((r) => r[0].length));
  const valueWidth = Math.max(...rows.filter((r) => r[1]).map((r) => r[1].length));

  const lines = ['cclimit settings', ''];
  for (const [name, value, how] of rows) {
    if (!name) {
      lines.push('');
      continue;
    }
    lines.push(`  ${name.padEnd(width)}   ${value.padEnd(valueWidth)}   ${how}`);
  }
  lines.push('');
  lines.push(`  Written to ${CONFIG_FILE}`);
  out(lines.join('\n'));
}

healWrapper();

const [first, second] = args;

if (!first || first === 'status') status();
else if (first === 'go' || first === 'continue') go();
else if (first === 'on') toggle(true);
else if (first === 'off') toggle(false);
else if (first === 'install') install();
else if (first === 'uninstall') uninstall();
else if (first === 'action') setAction(String(second || '').toLowerCase());
else if (first === 'ceiling' && windowKey(second)) setCeiling(windowKey(second), args[2]);
else if (first === 'notice' && windowKey(second)) setNotice(windowKey(second), args[2]);
else if (first === 'downgrade') setDowngrade(args[1]);
else if (first === 'alert') setAlert(args[1]);
else if (first === 'config' && second === 'path') out(CONFIG_FILE);
else if (first === 'config' || first === 'settings') configTable();
else if (windowKey(first) && second !== undefined) setThreshold(windowKey(first), second);
else if (Number.isFinite(Number(first))) setThreshold('five_hour', first);
// Every form listed here has to be one a user can actually type as a slash
// command, so `<percent>` on its own is deliberately not among them.
else
  die(
    `cclimit: don't know "${args.join(' ')}". Try: status | 5h <percent> | 7d <percent> | ` +
      `ceiling 5h <percent>|off | notice 5h <percent>|off | action stop|ask|warn | downgrade sonnet|haiku|off | ` +
      `config | go | on | off | install | uninstall`
  );
