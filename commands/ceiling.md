---
description: Set the usage percentage that /cclimit go cannot lift
argument-hint: "<5h|7d> <percent|off>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cclimit.mjs" ceiling $ARGUMENTS`

The command above already did the work and its output is the answer. Reply
with that text exactly as printed — same words, same line breaks, no code
fence, no summary, no rewording, no follow-up suggestions, nothing added
before or after. The only exception: if it printed an error, copy the error
and add one line saying what to run instead.
