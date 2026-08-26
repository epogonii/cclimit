#!/usr/bin/env node
// The collector. Claude Code hands the statusline command a JSON payload on
// stdin, and that payload is the only place the 5-hour and 7-day usage
// percentages are exposed — hooks never see them. So cclimit sits in the
// statusline pipe: it copies stdin to stdout untouched, then records what it
// saw for the gates to read.
//
//   node scripts/sink.mjs | <the statusline command you already had>
//   node scripts/sink.mjs --render        # no downstream command: print a line of our own
//
// stdout is written before anything else happens, so a broken config or an
// unwritable state directory can never delay or corrupt the user's statusline.

import fs from 'node:fs';
import process from 'node:process';
import {
  STATE_DIR,
  LIMITS_FILE,
  loadConfig,
  loadLimits,
  mergeLimits,
  evaluate,
  pendingNotice,
  armResume,
  pendingResume,
  writeBreach,
  clearBreach,
  recordHistory,
  pct,
  WINDOWS,
} from './lib.mjs';

const render = process.argv.includes('--render');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function indicator(rateLimits, breach) {
  const parts = [];
  for (const [key, meta] of Object.entries(WINDOWS)) {
    const win = rateLimits?.[key];
    if (win && typeof win.used_percentage === 'number') {
      parts.push(`${meta.label} ${pct(win.used_percentage)}`);
    }
  }
  if (!parts.length) return 'cclimit: no usage data on this account type';
  return `${breach ? '! ' : ''}${parts.join(' · ')}`;
}

const raw = readStdin();

let payload = null;
try {
  payload = JSON.parse(raw);
} catch {
  /* not our JSON — still pass it through below */
}

if (!render) process.stdout.write(raw);

try {
  const incoming = payload?.rate_limits ?? null;
  const config = loadConfig();

  // Read before the write below replaces it: a window rolling over is only
  // visible as the difference between two readings, and there is no second
  // chance to see it.
  const previous = incoming ? loadLimits()?.rate_limits ?? null : null;

  // What every other line here works from: the incoming reading with anything
  // an idle session brought back from the past dropped out of it.
  const rateLimits = incoming ? mergeLimits(previous, incoming) : null;
  const breach = evaluate(rateLimits, config);

  if (rateLimits) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LIMITS_FILE, JSON.stringify({ rate_limits: rateLimits, ts: Math.floor(Date.now() / 1000) }) + '\n');
    // The trail behind the last reading is what turns "you are at 90%" into
    // "the ceiling is twenty minutes away".
    recordHistory(rateLimits);
    armResume(previous, rateLimits, config);
  }

  // The breach file is the gates' fast path: its mere existence is the signal,
  // so the per-tool-call hook is three lines of shell and never starts Node.
  // A pending heads-up rides in the same file, because that file's existence is
  // the only thing that wakes the gate. It is written until the gate has said
  // it once, and not after, so the hot path goes cold again straight away
  // rather than starting Node on every call between here and the line.
  //
  // Order matters: a hold outranks a heads-up, and both outrank the news that
  // some other window has reset. A resume that loses that contest is not
  // queued — by the time the winner is settled, it is no longer news.
  if (breach) writeBreach(breach);
  else {
    const notice = pendingNotice(rateLimits, config);
    const resume = notice ? null : pendingResume(rateLimits, config);
    if (notice || resume) writeBreach(notice || resume);
    else clearBreach();
  }

  if (render) process.stdout.write(indicator(rateLimits, breach) + '\n');
} catch {
  if (render) process.stdout.write('\n');
}
