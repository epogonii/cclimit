#!/usr/bin/env node
// The slow path, reached only when scripts/gate.sh found a recent breach file.
// Decides what to do about it and prints the hook response.
//
// Every failure here is silent and permissive: no payload, no config, stale
// data, unexpected event — exit 0 with nothing on stdout, and Claude Code
// carries on as if the plugin were not installed.

import fs from 'node:fs';
import process from 'node:process';
import {
  loadConfig,
  loadBreach,
  clearBreach,
  loadHistory,
  loadNotices,
  markNoticed,
  disarmResume,
  cheaperModel,
  burnRate,
  minutesTo,
  alertSequence,
  breachMessage,
  noticeMessage,
  resumeMessage,
  downgradeMessage,
  pct,
  nowSeconds,
} from './lib.mjs';

function allow() {
  process.exit(0);
}

function emit(response) {
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}

// A stop that arrives mid-turn arrives while the user is somewhere else — that
// is the situation this plugin exists for, and a message nobody is looking at
// is not much better than no message. Claude Code emits the sequence on our
// behalf.
//
// Nothing is added to the prompt paths on purpose: a blocked prompt lands a
// second after the user pressed enter, and they are still watching the screen.
// A warn blocks nothing, so the same line fires again on the next tool call and
// the one after that. Saying it every time is the point of the action; ringing
// every time would be the interruption the action exists to avoid, so the bell
// is spent once per window and the message carries on alone.
//
// A stop ends the turn and an ask waits for an answer, so neither can repeat
// faster than the user can act on it. Only warn needs the damper.
function firstThisWindow(key) {
  if (loadNotices()[key] === (breach.resets_at ?? 0)) return false;
  markNoticed(key, breach.resets_at);
  return true;
}

function alerted(response, what) {
  const seq = alertSequence(config, `${breach.label} usage ${pct(breach.used_percentage)} \u2014 ${what}`);
  return seq ? { ...response, terminalSequence: seq } : response;
}

// Blocking a prompt otherwise echoes the prompt back under the reason, which
// buries the one line the user needs to read.
//
// The flag goes under hookSpecificOutput and nowhere else. The hooks reference
// lists it in the same table as `decision` and `reason`, which are top-level
// fields, so a copy up there looks like cheap insurance -- but the top-level
// response schema enumerates its fields (continue, suppressOutput, stopReason,
// decision, reason, systemMessage, terminalSequence, hookSpecificOutput) and
// this is not one of them, while the code that acts on it reads only the nested
// copy. So the copy buys nothing on a lenient parser and costs the whole
// response on a strict one.
function blockPrompt(reason) {
  emit({
    decision: 'block',
    reason,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
  });
}

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  allow();
}

const event = payload.hook_event_name;
if (event !== 'UserPromptSubmit' && event !== 'PreToolUse') allow();

const config = loadConfig();
if (!config.enabled) allow();

const now = nowSeconds();

const breach = loadBreach();
if (!breach || typeof breach.used_percentage !== 'number') allow();

// A reading old enough to be untrustworthy is not worth acting on, whichever
// kind of thing it turned out to be.
const age = now - (breach.ts ?? 0);
if (age > (config.maxStaleSeconds ?? 120)) allow();

// The breach file was written against whatever the numbers were at the time.
// Re-check against the config as it is now, so `/cclimit 5h 95` takes effect on
// the next tool call rather than on the next statusline render.
//
// A ceiling is checked first and is not snoozeable: `/cclimit go` answers the
// line, and the ceiling is precisely the number that answer does not reach.
const ceiling = config.ceilings?.[breach.window];
const line = config.thresholds?.[breach.window];
const snoozed = Boolean(config.snoozeUntil) && now < config.snoozeUntil;

// The heads-up is not a decision, so it is settled here and the file is cleared
// on the way out. Recording it before it is printed is deliberate: a notice
// shown twice is worse than one missed, and this is the only line of code that
// knows the sentence actually reached the user.
if (breach.kind === 'notice') {
  const notice = config.notices?.[breach.window];
  if (snoozed) allow();
  if (typeof notice !== 'number' || breach.used_percentage < notice) allow();
  if (typeof line === 'number' && breach.used_percentage >= line) allow();

  markNoticed(breach.window, breach.resets_at);
  clearBreach();

  const target = typeof line === 'number' ? line : typeof ceiling === 'number' ? ceiling : null;
  const rate = burnRate(loadHistory(), breach.window, now);
  emit({
    systemMessage: noticeMessage(breach, {
      target,
      minutes: target === null ? null : minutesTo(breach.used_percentage, target, rate),
    }),
  });
}

// The reset announcement is settled the same way and for the same reason: it
// decides nothing, and it is worth saying exactly once.
if (breach.kind === 'resume') {
  disarmResume(breach.window);
  clearBreach();
  emit({ systemMessage: resumeMessage(breach) });
}

let threshold = null;
let kind = null;
if (typeof ceiling === 'number' && breach.used_percentage >= ceiling) {
  threshold = ceiling;
  kind = 'ceiling';
} else if (!snoozed && typeof line === 'number' && breach.used_percentage >= line) {
  threshold = line;
  kind = 'line';
}
if (!kind) allow();

// Never stand in the way of the commands that turn this off — blocking those
// would leave the user with no way out but editing JSON by hand. The slash
// commands arrive here as a prompt, and the `!` line inside a command file runs
// without firing PreToolUse, so exempting the prompt is enough to keep every
// escape hatch open.
//
// There is deliberately no matching exemption for tool calls. A model-initiated
// `node .../cclimit.mjs off` would otherwise let Claude lift its own brake —
// which is exactly what this plugin exists to prevent — and matching the word
// loosely would disarm the gate for anyone working in a directory of that name.
if (event === 'UserPromptSubmit' && /(^|\s)\/cclimit(\s|:|$)/i.test(payload.prompt || '')) allow();

const tool = event === 'PreToolUse' ? payload.tool_name : null;
// A subagent launch is not one tool call, it is a whole session's worth of
// them, so it gets said out loud rather than folded into the generic line.
const isFanOut = tool === 'Task' || tool === 'Agent';

// Downgrading answers the line and only the line. A ceiling is the number that
// means stop, and moving the work onto a cheaper model is still doing the work.
if (kind === 'line' && typeof config.downgrade === 'string') {
  const model = config.downgrade;

  // A subagent is the one thing a hook can actually move: its model is part of
  // the tool input, and the input is the one field PreToolUse can rewrite.
  if (event === 'PreToolUse' && isFanOut) {
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const target = cheaperModel(input.model, model);
    if (!target) allow();
    emit({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, model: target } },
      systemMessage: `cclimit: past your ${breach.label} line \u2014 this subagent runs on ${target}.`,
    });
  }

  // Nothing here can move the session's own model, so the prompt gets the one
  // sentence that says so. Once per window: it is advice, not a decision, and
  // advice repeated on every prompt is just noise in front of the work.
  if (event === 'UserPromptSubmit') {
    const key = `downgrade:${breach.window}`;
    if (loadNotices()[key] === (breach.resets_at ?? 0)) allow();
    markNoticed(key, breach.resets_at);
    emit({ systemMessage: downgradeMessage({ ...breach, threshold }, config) });
  }

  allow();
}

// Only worth computing while the offer to continue is still on the table.
let headroom;
if (kind === 'line' && typeof ceiling === 'number') {
  const rate = burnRate(loadHistory(), breach.window, now);
  headroom = { ceiling, minutes: minutesTo(breach.used_percentage, ceiling, rate) };
}

let message = breachMessage({ ...breach, threshold, kind }, config, { tool, headroom });
if (isFanOut) {
  message += `\nThis call would start a subagent, which spends far more than a single tool call.`;
}

// A ceiling means stop, whatever the action says. An action is how you want to
// be told about the line; the ceiling is not up for discussion.
switch (kind === 'ceiling' ? 'stop' : config.action) {
  case 'warn':
    emit(
      event === 'PreToolUse' && firstThisWindow(`alert:${breach.window}`)
        ? alerted({ systemMessage: message }, 'past your line.')
        : { systemMessage: message }
    );
    break;

  case 'ask':
    if (event === 'PreToolUse') {
      emit(
        alerted(
          {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: message,
            },
          },
          'cclimit needs an answer.'
        )
      );
    }
    // A prompt is not a permission decision, so there is nothing to ask about
    // here — the same block the stop action uses is the honest equivalent.
    blockPrompt(message);
    break;

  case 'stop':
  default:
    if (event === 'PreToolUse') {
      emit(alerted({ continue: false, stopReason: message }, 'the turn stopped.'));
    }
    blockPrompt(message);
}
