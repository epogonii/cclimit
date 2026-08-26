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
export const HISTORY_FILE = path.join(STATE_DIR, 'history.json');
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
  // The number `/cclimit go` cannot lift. Off by default: with no ceiling set,
  // continuing past the line means continuing to 100%, which is the behaviour
  // everyone had before ceilings existed and is nobody's surprise.
  ceilings: { five_hour: null, seven_day: null },
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
    ceilings: { ...DEFAULTS.ceilings, ...(raw.ceilings || {}) },
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

  // A snooze is an answer to the line, not to the ceiling. That is the whole
  // point of having two numbers: `/cclimit go` means "carry on", and the
  // ceiling is what "carry on" is still not allowed to cross.
  const snoozed = Boolean(config.snoozeUntil) && now < config.snoozeUntil;

  let worst = null;
  for (const key of Object.keys(WINDOWS)) {
    const win = rateLimits[key];
    if (!win || typeof win.used_percentage !== 'number') continue;

    const ceiling = config.ceilings?.[key];
    const line = config.thresholds[key];
    let kind = null;
    let threshold = null;
    if (typeof ceiling === 'number' && win.used_percentage >= ceiling) {
      kind = 'ceiling';
      threshold = ceiling;
    } else if (!snoozed && typeof line === 'number' && win.used_percentage >= line) {
      kind = 'line';
      threshold = line;
    }
    if (!kind) continue;

    const candidate = {
      window: key,
      label: WINDOWS[key].label,
      used_percentage: win.used_percentage,
      kind,
      threshold,
      resets_at: Number.isFinite(win.resets_at) ? win.resets_at : null,
      ts: now,
    };
    // Both windows can be over at once. A ceiling outranks a line whatever the
    // margins are; between two of the same kind, the one further past it wins.
    const outranks =
      !worst ||
      (candidate.kind === 'ceiling' && worst.kind !== 'ceiling') ||
      (candidate.kind === worst.kind &&
        candidate.used_percentage - candidate.threshold > worst.used_percentage - worst.threshold);
    if (outranks) worst = candidate;
  }
  return worst;
}

// A short trail of readings, kept so the plugin can answer "will I get there"
// with the rate usage is actually climbing at rather than a guess. Readings
// arrive every statusline render, so a few dozen of them is minutes, not hours.
export const HISTORY_LIMIT = 60;

export function loadHistory() {
  const raw = readJson(HISTORY_FILE);
  return Array.isArray(raw) ? raw : [];
}

export function recordHistory(rateLimits, now = Math.floor(Date.now() / 1000)) {
  const entry = { ts: now };
  for (const key of Object.keys(WINDOWS)) {
    const used = rateLimits?.[key]?.used_percentage;
    if (typeof used === 'number') entry[key] = used;
  }
  if (Object.keys(entry).length === 1) return;
  const history = [...loadHistory().filter((e) => Number.isFinite(e?.ts) && e.ts <= now), entry].slice(-HISTORY_LIMIT);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history) + '\n');
}

// Percentage points per minute, or null when the trail cannot support a number:
// too few readings, too short a span, usage flat or falling. A window that has
// reset counts as falling, which is the honest answer — the rate before a reset
// says nothing about the rate after one.
export function burnRate(history, key, now = Math.floor(Date.now() / 1000)) {
  const points = (history || [])
    .filter((e) => Number.isFinite(e?.ts) && typeof e?.[key] === 'number' && now - e.ts <= 1800)
    .sort((a, b) => a.ts - b.ts);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const span = last.ts - first.ts;
  if (span < 60) return null;
  const climb = last[key] - first[key];
  if (climb <= 0) return null;
  return (climb / span) * 60;
}

// Minutes until usage reaches `target` at `perMinute`, rounded to something a
// person would say out loud. Null when the answer would be noise.
export function minutesTo(used, target, perMinute) {
  if (!Number.isFinite(used) || !Number.isFinite(target) || !Number.isFinite(perMinute) || perMinute <= 0) return null;
  const left = target - used;
  if (left <= 0) return 0;
  return Math.max(1, Math.round(left / perMinute));
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

// The sentence every gate shows. One line of fact, one line of what to do, and
// for a stop the line that says the turn is not coming back.
export function breachMessage(breach, config, { tool, headroom } = {}) {
  const at = localTime(breach.resets_at);
  const reset = at ? ` Window resets ${at} (in ${untilReset(breach.resets_at)}).` : '';
  const ceiling = breach.kind === 'ceiling';

  // Under `warn` nothing was stopped, so saying so would be a plain lie. A
  // ceiling always stops, whatever the action is, so it is never a warning.
  const warning = config.action === 'warn' && !ceiling;
  const verb = warning ? 'is past' : 'hit';
  const where = warning ? '' : ` Stopped ${tool ? `before running ${tool}` : 'before this turn'}.`;

  // Stopping ends the turn outright and nothing can revive it afterwards —
  // /cclimit go lifts the line for the next turn, it does not resume this one.
  // Left unsaid, it reads as a resume and the work looks lost.
  // Under `ask` the tool call goes to the permission prompt and the turn is
  // still alive, so only a real stop gets this line.
  const again =
    ceiling || config.action === 'stop' ? `\nThe turn ends here either way: ask for the work again afterwards.` : '';

  if (ceiling) {
    return (
      `cclimit: ${breach.label} usage hit ${pct(breach.used_percentage)} of your plan — your ceiling, ` +
      `which is the number /cclimit go does not lift.${where}${reset}\n` +
      `Raise it: /cclimit ceiling ${breach.label} ${Math.min(100, Math.ceil(breach.used_percentage) + 1)} — ` +
      `remove it: /cclimit ceiling ${breach.label} off — ` +
      `turn cclimit off: /cclimit off${again}`
    );
  }

  // What `go` actually buys is worth saying while the offer is on the table:
  // with a ceiling set it buys a known amount of work, not the rest of the
  // window.
  const stops = typeof headroom?.ceiling === 'number' ? ` Your ceiling is ${headroom.ceiling}%` : '';
  const away = stops && typeof headroom.minutes === 'number' ? `, about ${headroom.minutes}m away at the current rate` : '';
  const guard = stops ? `${stops}${away}.` : '';

  return (
    `cclimit: ${breach.label} usage ${verb} ${pct(breach.used_percentage)} of your plan ` +
    `(your limit: ${breach.threshold}%).${where}${reset}${guard ? ` ${guard}` : ''}\n` +
    `Continue until the window resets: /cclimit go — ` +
    `raise the line: /cclimit ${breach.label} ${Math.min(100, Math.ceil(breach.used_percentage) + 5)} — ` +
    `turn it off: /cclimit off${again}`
  );
}
