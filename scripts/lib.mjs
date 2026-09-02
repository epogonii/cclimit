// Shared state for cclimit: where things live, what the config means, and the
// one function that decides whether a usage window is over its threshold.
//
// Nothing here throws on bad input. Every reader returns a default instead, so
// a corrupt file can never turn into a blocked session — the plugin fails open
// by construction, not by a catch somewhere upstream.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
export const NOTICE_FILE = path.join(STATE_DIR, 'notice.json');
export const RESUME_FILE = path.join(STATE_DIR, 'resume.json');
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
  // A heads-up below the line, so the wall is not the first news of it. Off by
  // default, because an unasked-for interruption is the thing this plugin is
  // supposed to be careful about.
  notices: { five_hour: null, seven_day: null },
  // A model to push subagents onto once usage is past the line, instead of
  // stopping there. Off by default: quietly changing which model does the work
  // is a bigger thing to do unasked than declining to do it at all.
  downgrade: null,
  // How to make an interruption noticeable when nobody is watching the
  // terminal. `bell` rings it, `notify` adds a desktop notification where the
  // terminal understands one, `off` says nothing. On by default at `bell`,
  // because the whole point of a line is to be told when it is reached, and a
  // stop that arrives mid-turn arrives while the user is somewhere else.
  alert: 'bell',
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

// Every open session renders its own statusline every ten seconds, and every
// render rewrites these files. A reader that lands between another writer's
// truncate and its write sees an empty file, which readJson turns into "no
// data" -- and for the collector that means the trail behind the last reading
// is gone. So the text goes to a sibling file first and is renamed into place,
// which is the one step the filesystem promises to do whole or not at all.
// The temporary name is unique per process because those sessions write the
// same files at the same time.
function writeJson(file, value, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, pretty ? 2 : undefined) + '\n';
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    try {
      fs.renameSync(tmp, file);
    } catch {
      // A filesystem that refuses to replace a file someone has open loses the
      // atomicity, not the write.
      fs.writeFileSync(file, text);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed into place, or never written */
    }
  }
}

export function loadConfig() {
  const raw = readJson(CONFIG_FILE) || {};
  return {
    ...DEFAULTS,
    ...raw,
    thresholds: { ...DEFAULTS.thresholds, ...(raw.thresholds || {}) },
    ceilings: { ...DEFAULTS.ceilings, ...(raw.ceilings || {}) },
    notices: { ...DEFAULTS.notices, ...(raw.notices || {}) },
  };
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config, true);
}

// The models cclimit is willing to push work down onto, cheapest first. Only
// downward moves are ever made, so an already-cheap call is left alone.
export const DOWNGRADE_MODELS = ['haiku', 'sonnet'];
const MODEL_RANK = { haiku: 1, fable: 1, sonnet: 2, opus: 3 };

function modelRank(name) {
  const text = String(name || '').toLowerCase();
  for (const [key, rank] of Object.entries(MODEL_RANK)) if (text.includes(key)) return rank;
  return null;
}

// What `current` should be replaced with to reach `target`, or null for "leave
// it alone" — already at or below the target, or a name this does not
// recognise, which is somebody's deliberate choice and not ours to overrule.
// An absent model means the call inherits the session's, so it is fair game.
export function cheaperModel(current, target) {
  if (!DOWNGRADE_MODELS.includes(target)) return null;
  if (typeof current === 'string' && current && current !== 'inherit') {
    const rank = modelRank(current);
    if (rank === null) return null;
    if (rank <= MODEL_RANK[target]) return null;
  }
  return target;
}

export function loadLimits() {
  return readJson(LIMITS_FILE);
}

export function saveLimits(rateLimits, now = Math.floor(Date.now() / 1000)) {
  writeJson(LIMITS_FILE, { rate_limits: rateLimits, ts: now });
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
  writeJson(BREACH_FILE, breach);
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

// Which windows have already had their heads-up, keyed by the reset time of the
// window it was said for. A new window carries a new reset time, which re-arms
// the notice without anything having to expire or be cleaned up.
export function loadNotices() {
  const raw = readJson(NOTICE_FILE);
  return raw && typeof raw === 'object' ? raw : {};
}

export function markNoticed(key, resetsAt) {
  const seen = loadNotices();
  seen[key] = Number.isFinite(resetsAt) ? resetsAt : 0;
  try {
    writeJson(NOTICE_FILE, seen);
  } catch {
    /* a notice that cannot be recorded is a notice repeated, never a block */
  }
}

export function rearmNotice(key) {
  const seen = loadNotices();
  delete seen[key];
  try {
    writeJson(NOTICE_FILE, seen);
  } catch {
    /* nothing to undo */
  }
}

// The heads-up, which is not a breach: nothing is held, nothing is decided, and
// it is said once per window rather than once per tool call. It travels in the
// breach file only because that file is what wakes the gate at all; the gate
// clears it as soon as the sentence has been delivered.
export function pendingNotice(rateLimits, config, now = Math.floor(Date.now() / 1000)) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  if (!config.enabled) return null;
  // `/cclimit go` is the user saying they know where usage stands. Telling them
  // again is noise.
  if (config.snoozeUntil && now < config.snoozeUntil) return null;

  const seen = loadNotices();
  let worst = null;
  for (const key of Object.keys(WINDOWS)) {
    const win = rateLimits[key];
    if (!win || typeof win.used_percentage !== 'number') continue;

    const notice = config.notices?.[key];
    if (typeof notice !== 'number' || win.used_percentage < notice) continue;
    // Past the line, the line has its own thing to say and says it first.
    const line = config.thresholds?.[key];
    if (typeof line === 'number' && win.used_percentage >= line) continue;

    const resets_at = Number.isFinite(win.resets_at) ? win.resets_at : null;
    if (seen[key] === (resets_at ?? 0)) continue;

    const candidate = {
      window: key,
      label: WINDOWS[key].label,
      used_percentage: win.used_percentage,
      kind: 'notice',
      threshold: notice,
      resets_at,
      ts: now,
    };
    if (!worst || candidate.used_percentage - notice > worst.used_percentage - worst.threshold) worst = candidate;
  }
  return worst;
}

// A window that has rolled over is worth one sentence, because the last thing
// said about it was that it was full. Armed by the collector at the moment the
// reset time changes — the only moment the change is visible — and said by the
// gate whenever the user next turns up, which may be hours later.
export function armResume(prev, rateLimits, config, now = Math.floor(Date.now() / 1000)) {
  if (!prev || !rateLimits || !config.enabled) return null;

  const armed = readJson(RESUME_FILE) || {};
  let changed = false;
  for (const key of Object.keys(WINDOWS)) {
    const before = prev[key];
    const after = rateLimits[key];
    if (!before || !after) continue;
    if (!Number.isFinite(before.resets_at) || !Number.isFinite(after.resets_at)) continue;
    // A new reset time is what a rollover looks like; usage falling is what
    // proves it was one rather than the window being extended.
    if (after.resets_at <= before.resets_at) continue;
    if (typeof before.used_percentage !== 'number' || typeof after.used_percentage !== 'number') continue;
    if (after.used_percentage >= before.used_percentage) continue;

    // Only windows that had something to say on the way up get to say anything
    // on the way down. A window that reset from 12% was nobody's problem.
    const line = config.thresholds?.[key];
    const notice = config.notices?.[key];
    const loud = typeof notice === 'number' ? notice : line;
    if (typeof loud !== 'number' || before.used_percentage < loud) continue;

    armed[key] = { resets_at: after.resets_at, from: before.used_percentage, ts: now };
    changed = true;
  }
  if (!changed) return null;

  try {
    writeJson(RESUME_FILE, armed);
  } catch {
    /* an announcement that cannot be recorded is one not made, never a block */
  }
  return armed;
}

export function pendingResume(rateLimits, config, now = Math.floor(Date.now() / 1000)) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  if (!config.enabled) return null;

  const armed = readJson(RESUME_FILE);
  if (!armed || typeof armed !== 'object') return null;

  for (const key of Object.keys(WINDOWS)) {
    const record = armed[key];
    const win = rateLimits[key];
    if (!record || !win || typeof win.used_percentage !== 'number') continue;
    // Armed against one particular window. If that one has itself reset while
    // nobody was looking, the sentence is about a window two ago and is dropped.
    if (win.resets_at !== record.resets_at) continue;
    const line = config.thresholds?.[key];
    // Back over the line already: the line has its own thing to say.
    if (typeof line === 'number' && win.used_percentage >= line) continue;

    return {
      window: key,
      label: WINDOWS[key].label,
      used_percentage: win.used_percentage,
      kind: 'resume',
      threshold: typeof line === 'number' ? line : null,
      from: record.from,
      resets_at: win.resets_at,
      ts: now,
    };
  }
  return null;
}

export function disarmResume(key) {
  const armed = readJson(RESUME_FILE) || {};
  delete armed[key];
  try {
    writeJson(RESUME_FILE, armed);
  } catch {
    /* nothing to undo */
  }
}

// A short trail of readings, kept so the plugin can answer "will I get there"
// with the rate usage is actually climbing at rather than a guess. Readings
// arrive every statusline render — one every ten seconds — so the limit below is
// about an hour of them, which is what the sparkline draws.
export const HISTORY_LIMIT = 360;

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
  writeJson(HISTORY_FILE, history);
}

// Every session renders its own statusline, and the payload it renders carries
// that session's last known usage — which in a session sitting idle can be
// hours old. So the collector is written to by every open window at once, and
// a stale one would otherwise overwrite the live reading with a number from
// before the work happened, taking the gates down with it.
//
// Usage inside a window only ever climbs, and a reading from a window that has
// already reset carries the old reset time. Both are enough to tell a stale
// reading from a new one without asking which session it came from.
export function mergeLimits(previous, incoming) {
  if (!incoming || typeof incoming !== 'object') return incoming ?? null;
  if (!previous || typeof previous !== 'object') return incoming;

  const merged = {};
  for (const [key, win] of Object.entries(incoming)) {
    const before = previous[key];
    const stale = before?.resets_at;
    const fresh = win?.resets_at;
    if (
      typeof stale === 'number' &&
      typeof fresh === 'number' &&
      typeof before?.used_percentage === 'number' &&
      typeof win?.used_percentage === 'number'
    ) {
      // A reading from a window that has already turned over says nothing about
      // the one running now.
      if (fresh < stale) {
        merged[key] = before;
        continue;
      }
      if (fresh === stale && win.used_percentage < before.used_percentage) {
        merged[key] = { ...win, used_percentage: before.used_percentage };
        continue;
      }
    }
    merged[key] = win;
  }
  return merged;
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

// Where the window lands at the current rate if nothing changes. Only answered
// for a reset close enough for a half-hour sample to mean anything about it:
// extrapolating this morning's pace across five more days of a weekly window
// produces a number with no information in it.
export const PROJECTION_HORIZON = 6 * 3600;

export function projectedAtReset(used, resetsAt, perMinute, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(used) || !Number.isFinite(resetsAt)) return null;
  if (!Number.isFinite(perMinute) || perMinute <= 0) return null;
  const seconds = resetsAt - now;
  if (seconds <= 0 || seconds > PROJECTION_HORIZON) return null;
  return used + perMinute * (seconds / 60);
}

// The last hour of burn, one cell per bucket, drawn from what was gained inside
// each bucket rather than the level it stood at — a climbing total drawn as a
// level is a ramp, and a ramp says nothing about when the spending happened.
const SPARK_CHARS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';

export function sparkline(history, key, now = Math.floor(Date.now() / 1000), cells = 30, seconds = 3600) {
  const points = (history || [])
    .filter((e) => Number.isFinite(e?.ts) && typeof e?.[key] === 'number' && now - e.ts <= seconds)
    .sort((a, b) => a.ts - b.ts);
  if (points.length < 2) return null;

  const end = Math.max(now, points[points.length - 1].ts);

  // The percentages arrive as whole numbers, so an hour of steady work is not a
  // curve but a staircase: nothing, nothing, a step, nothing. Drawn as it
  // arrives that is a comb of spikes with gaps between them, which says the
  // work happened in bursts it did not happen in. The spending that produced a
  // step happened over the stretch leading up to it, so the curve is rebuilt
  // from the moments the number moved and read as a straight line between them.
  const changes = [{ ts: points[0].ts, used: points[0][key] }];
  for (const point of points) {
    if (point[key] !== changes[changes.length - 1].used) changes.push({ ts: point.ts, used: point[key] });
  }
  // One step is a fact, not a shape. Two are the least that can differ.
  if (changes.length < 3) return null;

  // The chart starts at the first step rather than the first reading: whatever
  // earned that step was partly spent before the trail began, so the stretch in
  // front of it is a rate that looks higher than the work that produced it.
  const start = changes[1].ts;
  const span = end - start;
  if (span < 120) return null;

  const valueAt = (t) => {
    if (t <= changes[0].ts) return changes[0].used;
    for (let i = 1; i < changes.length; i += 1) {
      if (t > changes[i].ts) continue;
      const from = changes[i - 1];
      const to = changes[i];
      const gap = to.ts - from.ts;
      // A fall is a window reset, not a slope to draw down.
      if (gap <= 0 || to.used < from.used) return to.used;
      return from.used + (to.used - from.used) * ((t - from.ts) / gap);
    }
    return changes[changes.length - 1].used;
  };

  const step = span / cells;
  const deltas = [];
  for (let i = 0; i < cells; i += 1) {
    // A reset inside the hour shows up as a fall. Clamped, because "spent
    // nothing" is the truthful shape of the bucket the window turned over in.
    deltas.push(Math.max(0, valueAt(start + (i + 1) * step) - valueAt(start + i * step)));
  }

  const peak = Math.max(...deltas);
  if (peak <= 0) return null;

  // Height is relative to the busiest bucket, so a steady hour would otherwise
  // scale up into a solid black wall that reads as trouble. An even burn is
  // drawn as the level line it is. Measured against the middle bucket rather
  // than the quietest, so that the one bucket the last step has not landed in
  // yet does not turn a flat hour into a cliff.
  const sorted = [...deltas].sort((a, b) => a - b);
  const even = peak - sorted[Math.floor(cells / 2)] <= peak * 0.2;

  return {
    text: deltas.map((d) => (even ? SPARK_CHARS[3] : SPARK_CHARS[Math.min(7, Math.round((d / peak) * 7))])).join(''),
    minutes: Math.max(1, Math.round(span / 60)),
    peak,
  };
}

// Claude Code resolves ${CLAUDE_PLUGIN_ROOT} once, when a session starts, so a
// session that was running when the plugin was updated keeps executing the
// version it started with until it is restarted. For a plugin whose whole job
// is to be right about a number, that is the wrong default: an update should
// take hold at once.
//
// So both entry points look for a newer copy of themselves and hand over to it.
// Newest means most recently installed, matching the statusline wrapper, and
// any doubt at all — no cache, unreadable directory, same copy, missing file —
// means staying put and running as before.
// bin/ was the layout up to 0.5.1. A copy installed then is still a real
// copy, so both names are looked at and neither is assumed.
const LAYOUTS = ['scripts', 'bin'];

export function newerSelf(here, file) {
  if (process.env.CCLIMIT_NO_FORWARD) return null;
  const cache = path.join(CONFIG_DIR, 'plugins', 'cache');
  let best = null;
  try {
    for (const market of fs.readdirSync(cache)) {
      const versions = path.join(cache, market, 'cclimit');
      let entries;
      try {
        entries = fs.readdirSync(versions);
      } catch {
        continue;
      }
      for (const version of entries) {
        for (const layout of LAYOUTS) {
          const candidate = path.join(versions, version, layout);
          if (candidate === here) continue;
          let stat;
          try {
            stat = fs.statSync(path.join(candidate, file));
          } catch {
            continue;
          }
          if (!best || stat.mtimeMs > best.mtimeMs) best = { dir: candidate, mtimeMs: stat.mtimeMs };
        }
      }
    }
  } catch {
    return null;
  }
  if (!best) return null;
  // Only hand over to something installed after this copy: a leftover older
  // version must never win, and neither must a copy running outside the cache.
  let own;
  try {
    own = fs.statSync(path.join(here, file)).mtimeMs;
  } catch {
    return null;
  }
  if (best.mtimeMs <= own) return null;

  // An update caught halfway leaves a directory that exists and does not run.
  // Handing the user's escape hatch to it would turn a stale version — which
  // works — into no version at all, so it has to be whole before it is trusted.
  if (!fs.existsSync(path.join(best.dir, 'lib.mjs'))) return null;
  const target = path.join(best.dir, file);
  const parses = spawnSync(process.execPath, ['--check', target], { stdio: 'ignore' });
  if (parses.error || parses.status !== 0) return null;

  return target;
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
  return span(seconds / 60);
}

// A stretch of time, said the way a person would say it. Left in minutes, a
// long wait comes out as `1835m`, which has to be divided before it means
// anything.
export function span(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours && rest) return `${hours}h ${rest}m`;
  if (hours) return `${hours}h`;
  return `${rest}m`;
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

// Which desktop-notification escape sequence this terminal understands, or
// null. There is no common one: each terminal family invented its own OSC, and
// a terminal sent a sequence it does not know may print the payload as text
// instead of swallowing it. So this answers only for terminals it recognises,
// and everything else settles for the bell.
//
// Most terminals outside macOS never set TERM_PROGRAM, so TERM has to carry the
// answer on its own for the ones that ship on Linux.
//
// Deliberately not here: GNOME Terminal and the rest of the VTE family. OSC 777
// reached VTE as a distribution patch rather than upstream, so the same
// terminal answers it on one machine and ignores it on the next, and there is
// no way to tell which from inside a hook. They get the bell.
function notifySequence(title, body, env = process.env) {
  const program = env.TERM_PROGRAM || '';
  const term = env.TERM || '';
  const bel = '\u0007';

  // kitty's own protocol. The two empty parameters are the notification id and
  // the "this is the whole payload" flag, both of which default correctly.
  if (term.includes('kitty')) return `\u001b]99;;${title}: ${body}\u001b\\`;

  // OSC 777 started as an urxvt extension and was taken up by terminals that
  // grew up on Linux.
  if (
    program === 'ghostty' ||
    term.includes('ghostty') ||
    program === 'WarpTerminal' ||
    term.startsWith('rxvt') ||
    term.startsWith('foot')
  ) {
    return `\u001b]777;notify;${title};${body}${bel}`;
  }

  // OSC 9 is the oldest and the widest: iTerm2 invented it and ConEmu, Windows
  // Terminal and WezTerm all took it.
  if (
    program === 'iTerm.app' ||
    program === 'WezTerm' ||
    term.includes('wezterm') ||
    env.WT_SESSION ||
    env.ConEmuPID
  ) {
    return `\u001b]9;${title}: ${body}${bel}`;
  }

  return null;
}

// What to put in `terminalSequence` when the gate interrupts a turn, or null.
// Claude Code emits this on the hook's behalf — a hook has no controlling
// terminal of its own — and drops the whole field if any part of it falls
// outside its allowlist of OSC 0/1/2/9/99/777 and BEL.
export function alertSequence(config, body) {
  const mode = config?.alert;
  if (mode !== 'bell' && mode !== 'notify') return null;
  const bell = '\u0007';
  if (mode === 'bell') return bell;
  // The bell goes out either way: a notification that the terminal silently
  // dropped would leave nothing at all.
  return bell + (notifySequence('cclimit', body, process.env) || '');
}

// What to do about a breach, one command to a line. Run together in a sentence
// they are three clauses that have to be taken apart before any of them can be
// typed, and the whole message is read by someone who has just been
// interrupted; in a column they are read at a glance and copied whole.
function options(rows) {
  const width = Math.max(...rows.map(([command]) => command.length));
  return rows.map(([command, what]) => `  ${command.padEnd(width)}   ${what}`).join('\n');
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
    ceiling || config.action === 'stop'
      ? `\n\nThe turn ends here either way: ask for the work again afterwards.`
      : '';

  if (ceiling) {
    return (
      [
        `cclimit: ${breach.label} usage hit ${pct(breach.used_percentage)} of your plan — your ceiling, ` +
          `which is the number /cclimit go does not lift.`,
        `${where}${reset}`.trim(),
      ]
        .filter(Boolean)
        .join('\n') +
      `\n\n` +
      options([
        [`/cclimit ceiling ${breach.label} ${Math.min(100, Math.ceil(breach.used_percentage) + 1)}`, 'raise the ceiling'],
        [`/cclimit ceiling ${breach.label} off`, 'remove the ceiling'],
        ['/cclimit off', 'turn cclimit off'],
      ]) +
      again
    );
  }

  // What `go` actually buys is worth saying while the offer is on the table:
  // with a ceiling set it buys a known amount of work, not the rest of the
  // window.
  const stops = typeof headroom?.ceiling === 'number' ? ` Your ceiling is ${headroom.ceiling}%` : '';
  const away = stops && typeof headroom.minutes === 'number' ? `, about ${span(headroom.minutes)} away at the current rate` : '';
  const guard = stops ? `${stops}${away}.`.trim() : '';

  const head = [
    `cclimit: ${breach.label} usage ${verb} ${pct(breach.used_percentage)} of your plan (your limit: ${breach.threshold}%).`,
    `${where}${reset}`.trim(),
    guard,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    `${head}\n\n` +
    options([
      ['/cclimit go', 'continue until the window resets'],
      [`/cclimit ${breach.label} ${Math.min(100, Math.ceil(breach.used_percentage) + 5)}`, 'raise the line'],
      ['/cclimit off', 'turn cclimit off'],
    ]) +
    again
  );
}

// The heads-up sentence. It has to read as information rather than as an
// interruption, so it says what is not happening before it says what to run.
export function noticeMessage(breach, { target, minutes } = {}) {
  const at = localTime(breach.resets_at);
  const reset = at ? ` Window resets ${at} (in ${untilReset(breach.resets_at)}).` : '';
  const eta = typeof minutes === 'number' ? `, about ${span(minutes)} away at the current rate` : '';
  const wall = typeof target === 'number' ? ` Work stops at ${target}%${eta}.` : '';
  return (
    `cclimit: ${breach.label} usage is at ${pct(breach.used_percentage)} of your plan.${wall}${reset}\n` +
    `Nothing is blocked — this is the heads-up, said once per window. ` +
    `Move it: /cclimit notice ${breach.label} <percent> — remove it: /cclimit notice ${breach.label} off`
  );
}

// Said when a window that was full has rolled over. It is the only message here
// that reports good news, so it leads with the fact and keeps the arithmetic to
// one clause.
export function resumeMessage(resume) {
  const from = typeof resume.from === 'number' ? ` It was at ${pct(resume.from)} before the reset.` : '';
  const line = typeof resume.threshold === 'number' ? ` Work stops again at ${resume.threshold}%.` : '';
  const at = localTime(resume.resets_at);
  const next = at ? ` The new window resets ${at}.` : '';
  return (
    `cclimit: the ${resume.label} window reset \u2014 usage is at ${pct(resume.used_percentage)} of your plan.${from}\n` +
    `Nothing is being held.${line}${next}`
  );
}

// Said once per window when the line is answered by moving work onto a cheaper
// model instead of stopping. It has to be explicit that nothing was blocked and
// that the main session is not covered, because neither is visible from here.
export function downgradeMessage(breach, config) {
  const model = config.downgrade;
  const ceiling = config.ceilings?.[breach.window];
  const stop = typeof ceiling === 'number' ? ` Your ceiling at ${ceiling}% still stops everything.` : '';
  const at = localTime(breach.resets_at);
  const reset = at ? ` Window resets ${at} (in ${untilReset(breach.resets_at)}).` : '';
  return (
    `cclimit: ${breach.label} usage is at ${pct(breach.used_percentage)} of your plan ` +
    `(your limit: ${breach.threshold}%). Nothing is stopped \u2014 subagents started from here on ` +
    `run on ${model}.${stop}${reset}\n` +
    `This session keeps its own model: /model ${model} to move it too \u2014 ` +
    `stop instead of downgrading: /cclimit downgrade off`
  );
}
