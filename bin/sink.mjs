#!/usr/bin/env node
// The collector. Claude Code hands the statusline command a JSON payload on
// stdin, and that payload is the only place the 5-hour and 7-day usage
// percentages are exposed — hooks never see them. So cclimit sits in the
// statusline pipe: it copies stdin to stdout untouched, then records what it
// saw for the gates to read.
//
//   node bin/sink.mjs | <the statusline command you already had>
//   node bin/sink.mjs --render        # no downstream command: print a line of our own
//
// stdout is written before anything else happens, so a broken config or an
// unwritable state directory can never delay or corrupt the user's statusline.

import fs from 'node:fs';
import process from 'node:process';
import { STATE_DIR, LIMITS_FILE, loadConfig, evaluate, writeBreach, clearBreach, pct, WINDOWS } from './lib.mjs';

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
  const rateLimits = payload?.rate_limits ?? null;
  const config = loadConfig();
  const breach = evaluate(rateLimits, config);

  if (rateLimits) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LIMITS_FILE, JSON.stringify({ rate_limits: rateLimits, ts: Math.floor(Date.now() / 1000) }) + '\n');
  }

  // The breach file is the gates' fast path: its mere existence is the signal,
  // so the per-tool-call hook is three lines of shell and never starts Node.
  if (breach) writeBreach(breach);
  else clearBreach();

  if (render) process.stdout.write(indicator(rateLimits, breach) + '\n');
} catch {
  if (render) process.stdout.write('\n');
}
