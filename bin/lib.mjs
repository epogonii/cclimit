// Shared state for cclimit: where things live, what the config means, and the
// one function that decides whether a usage window is over its threshold.
//
// Nothing here throws on bad input. Every reader returns a default instead, so
// a corrupt file can never turn into a blocked session — the plugin fails open
// by construction, not by a catch somewhere upstream.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CCLIMIT_CONFIG_DIR exists for the tests, which must never touch a real
// ~/.claude. CLAUDE_CONFIG_DIR is Claude Code's own override and is honoured
// for people who moved their config elsewhere.
export const CONFIG_DIR =
  process.env.CCLIMIT_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export const STATE_DIR = path.join(CONFIG_DIR, 'cclimit');
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
export const LIMITS_FILE = path.join(STATE_DIR, 'limits.json');
export const BREACH_FILE = path.join(STATE_DIR, 'breach.json');
export const WRAP_FILE = path.join(STATE_DIR, 'statusline-wrap.sh');
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

export const WINDOWS = {
  five_hour: { label: '5h', flag: '5h' },
  seven_day: { label: '7d', flag: '7d' },
};

export const DEFAULTS = {
  enabled: true,
  // stop  — halt the turn outright (continue: false)
  // ask   — hand the tool call to the permission prompt (asks again per call)
  // warn  — let everything through, print a line above the answer
  action: 'stop',
  thresholds: { five_hour: 85, seven_day: 90 },
  // Set by `/cclimit go` to a unix timestamp — usually the reset time of the
  // window that fired. Until then the gates stay quiet.
  snoozeUntil: null,
  // A statusline that stopped rendering (session closed, command removed)
  // leaves a stale breach file behind. Anything older than this is ignored.
  maxStaleSeconds: 120,
  // Filled in by `install` so `uninstall` can put the old statusline back.
  originalStatusLine: null,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig() {
  const raw = readJson(CONFIG_FILE) || {};
  return {
    ...DEFAULTS,
    ...raw,
    thresholds: { ...DEFAULTS.thresholds, ...(raw.thresholds || {}) },
  };
}

export function saveConfig(config) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

export function loadLimits() {
  return readJson(LIMITS_FILE);
}

export function loadBreach() {
  return readJson(BREACH_FILE);
}

export function clearBreach() {
  try {
    fs.unlinkSync(BREACH_FILE);
  } catch {
    /* already gone */
  }
}

export function writeBreach(breach) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(BREACH_FILE, JSON.stringify(breach) + '\n');
}

// The one decision. `rateLimits` is the object Claude Code puts in the
// statusline payload: { five_hour: { used_percentage, resets_at }, ... }.
// Percentages come through as floats with rounding dirt on them (56.00000000000001),
// so the comparison is >= and never ==.
export function evaluate(rateLimits, config, now = Math.floor(Date.now() / 1000)) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  if (!config.enabled) return null;
  if (config.snoozeUntil && now < config.snoozeUntil) return null;

  let worst = null;
  for (const key of Object.keys(WINDOWS)) {
    const win = rateLimits[key];
    if (!win || typeof win.used_percentage !== 'number') continue;
    const threshold = config.thresholds[key];
    if (typeof threshold !== 'number') continue;
    if (win.used_percentage < threshold) continue;
    const candidate = {
      window: key,
      label: WINDOWS[key].label,
      used_percentage: win.used_percentage,
      threshold,
      resets_at: Number.isFinite(win.resets_at) ? win.resets_at : null,
      ts: now,
    };
    // Both windows can be over at once. Report the one further past its line.
    if (!worst || candidate.used_percentage - candidate.threshold > worst.used_percentage - worst.threshold) {
      worst = candidate;
    }
  }
  return worst;
}

export function pct(value) {
  return `${Math.round(value)}%`;
}

// Both of these take a Unix timestamp in seconds, which is what the statusline
// payload carries. Anything else — a string, a null, a future change of format
// — has to read as "no reset time known", never as "Invalid Date" in the middle
// of a sentence the user is meant to act on.
export function untilReset(resetsAt, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const seconds = resetsAt - now;
  if (seconds <= 0) return 'any moment now';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

export function localTime(resetsAt) {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  // The order of the parts is the reader's locale to decide, but the clock is
  // not: `01:00 PM` costs a beat to read in the middle of a sentence that has
  // interrupted you, and `13:00` does not.
  return new Date(resetsAt * 1000).toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
    hour12: false,
  });
}

// The sentence every gate shows. One line of fact, one line of what to do.
export function breachMessage(breach, config, { tool } = {}) {
  const where = tool ? `before running ${tool}` : 'before this turn';
  const at = localTime(breach.resets_at);
  const reset = at ? ` Window resets ${at} (in ${untilReset(breach.resets_at)}).` : '';
  const verb = config.action === 'warn' ? 'is past' : 'hit';
  return (
    `cclimit: ${breach.label} usage ${verb} ${pct(breach.used_percentage)} of your plan ` +
    `(your limit: ${breach.threshold}%). Stopped ${where}.${reset}\n` +
    `Continue until the window resets: /cclimit go — ` +
    `raise the line: /cclimit ${breach.label} ${Math.min(100, Math.ceil(breach.used_percentage) + 5)} — ` +
    `turn it off: /cclimit off`
  );
}
