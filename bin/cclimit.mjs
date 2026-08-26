#!/usr/bin/env node
// The command surface behind /cclimit. Everything the user can change lives in
// one small JSON file; this reads and writes it, and wires the collector into
// the statusline.
//
//   cclimit status              what the limits are and where usage stands
//   cclimit 5h 85               stop at 85% of the 5-hour window
//   cclimit 7d 90               stop at 90% of the 7-day window
//   cclimit action stop|ask|warn
//   cclimit go                  keep going until the window resets
//   cclimit on | off
//   cclimit install | uninstall

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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
  clearBreach,
  evaluate,
  pct,
  untilReset,
  localTime,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SINK = path.join(HERE, 'sink.mjs');
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

function status() {
  const config = loadConfig();
  const usage = currentUsage();
  const breach = loadBreach();

  if (asJson) {
    out(JSON.stringify({ config, usage, breach }, null, 2));
    return;
  }

  const lines = [];
  const state = !config.enabled
    ? 'off'
    : config.snoozeUntil && now < config.snoozeUntil
      ? `snoozed until ${localTime(config.snoozeUntil)} (${untilReset(config.snoozeUntil)} left)`
      : `on, action: ${config.action}`;
  lines.push(`cclimit is ${state}`);

  for (const [key, meta] of Object.entries(WINDOWS)) {
    const win = usage?.rateLimits?.[key];
    const limit = config.thresholds[key];
    if (!win || typeof win.used_percentage !== 'number') {
      lines.push(`  ${meta.label}  no data yet  (stop at ${limit}%)`);
      continue;
    }
    const flag = win.used_percentage >= limit ? '  <- over your line' : '';
    const at = localTime(win.resets_at);
    const reset = at ? `, resets ${at} (in ${untilReset(win.resets_at)})` : '';
    lines.push(`  ${meta.label}  ${pct(win.used_percentage)} used, stop at ${limit}%${reset}${flag}`);
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

  if (breach) {
    lines.push('');
    lines.push(`Currently holding: ${breach.label} at ${pct(breach.used_percentage)} of ${breach.threshold}%.`);
    lines.push('Run /cclimit go to continue until the window resets.');
  }
  out(lines.join('\n'));
}

function setThreshold(key, valueRaw) {
  const value = Number(valueRaw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) die(`Threshold must be a number between 1 and 100, got: ${valueRaw}`);
  const config = loadConfig();
  config.thresholds[key] = value;
  // A new line the current usage clears makes the old snooze meaningless.
  config.snoozeUntil = null;
  saveConfig(config);
  refreshBreach(config);
  out(`cclimit: ${WINDOWS[key].label} window now stops at ${value}%.`);
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

// Keep the breach file honest after a config change, instead of waiting for the
// next statusline render to catch up.
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
  let until = breach?.resets_at ?? null;
  if (!until && usage) {
    const resets = Object.keys(WINDOWS)
      .map((k) => usage.rateLimits[k]?.resets_at)
      .filter((t) => typeof t === 'number' && t > now);
    until = resets.length ? Math.min(...resets) : null;
  }
  config.snoozeUntil = until ?? now + 3600;
  saveConfig(config);
  clearBreach();
  out(
    `cclimit: standing down until ${localTime(config.snoozeUntil)} (${untilReset(config.snoozeUntil)}). ` +
      `Usage past your line from here on is on you. /cclimit on to reinstate it sooner.`
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

// The wrapper cannot hard-code the path to the collector and stop there:
// installing a plugin puts it in a directory named after its version, so the
// next `claude plugin update` moves the collector out from under a path
// recorded today. The pinned path is therefore only the first guess, a search
// of the plugin cache is the second, and passing stdin straight through is the
// answer when neither finds anything — an update must never be able to leave
// someone with no statusline at all.
function wrapperScript(downstream) {
  const collector = downstream ? `node "$SINK" | ${downstream}` : 'node "$SINK" --render';
  const passthrough = downstream ? `cat | ${downstream}` : 'echo';
  return `#!/bin/sh
# Generated by cclimit install: the cclimit collector piped in front of the
# statusline command that was here before. The collector copies stdin through
# untouched. Remove it with /cclimit uninstall, which also restores
# settings.json.
#
# The collector is looked up rather than fixed in place, because a plugin
# update moves it into a directory named after the new version. If no copy of
# it can be found at all, the statusline runs without it.
SINK=${shellQuote(SINK)}
[ -f "$SINK" ] || SINK=$(ls -1dt "$HOME"/.claude/plugins/cache/*/cclimit/*/bin/sink.mjs 2>/dev/null | head -1)
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

const [first, second] = args;

if (!first || first === 'status') status();
else if (first === 'go' || first === 'continue') go();
else if (first === 'on') toggle(true);
else if (first === 'off') toggle(false);
else if (first === 'install') install();
else if (first === 'uninstall') uninstall();
else if (first === 'action') setAction(String(second || '').toLowerCase());
else if (first === 'config') out(CONFIG_FILE);
else if (windowKey(first) && second !== undefined) setThreshold(windowKey(first), second);
else if (Number.isFinite(Number(first))) setThreshold('five_hour', first);
// Every form listed here has to be one a user can actually type as a slash
// command, so `<percent>` on its own is deliberately not among them.
else die(`cclimit: don't know "${args.join(' ')}". Try: status | 5h <percent> | 7d <percent> | action stop|ask|warn | go | on | off | install | uninstall`);
