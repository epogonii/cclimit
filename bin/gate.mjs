#!/usr/bin/env node
// The slow path, reached only when bin/gate.sh found a recent breach file.
// Decides what to do about it and prints the hook response.
//
// Every failure here is silent and permissive: no payload, no config, stale
// data, unexpected event — exit 0 with nothing on stdout, and Claude Code
// carries on as if the plugin were not installed.

import fs from 'node:fs';
import process from 'node:process';
import { loadConfig, loadBreach, breachMessage } from './lib.mjs';

function allow() {
  process.exit(0);
}

function emit(response) {
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}

// Blocking a prompt otherwise echoes the prompt back under the reason, which
// buries the one line the user needs to read.
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

const now = Math.floor(Date.now() / 1000);
if (config.snoozeUntil && now < config.snoozeUntil) allow();

const breach = loadBreach();
if (!breach || typeof breach.used_percentage !== 'number') allow();

// The breach file was written against whatever the thresholds were at the time.
// Re-check against the config as it is now, so `/cclimit 5h 95` takes effect on
// the next tool call rather than on the next statusline render.
const threshold = config.thresholds?.[breach.window];
if (typeof threshold !== 'number' || breach.used_percentage < threshold) allow();

const age = now - (breach.ts ?? 0);
if (age > (config.maxStaleSeconds ?? 120)) allow();

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
let message = breachMessage({ ...breach, threshold }, config, { tool });
if (isFanOut) {
  message += `\nThis call would start a subagent, which spends far more than a single tool call.`;
}

switch (config.action) {
  case 'warn':
    emit({ systemMessage: message, suppressOutput: true });
    break;

  case 'ask':
    if (event === 'PreToolUse') {
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: message,
        },
      });
    }
    // A prompt is not a permission decision, so there is nothing to ask about
    // here — the same block the stop action uses is the honest equivalent.
    blockPrompt(message);
    break;

  case 'stop':
  default:
    if (event === 'PreToolUse') {
      emit({ continue: false, stopReason: message, suppressOutput: true });
    }
    blockPrompt(message);
}
