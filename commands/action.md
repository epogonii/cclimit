---
description: What a crossing does: stop, ask or warn
argument-hint: "<stop|ask|warn>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/cclimit.mjs" action $ARGUMENTS`

The command above already did the work and its output is the answer. Reply
with that text exactly as printed — same words, same line breaks, no code
fence, no summary, no rewording, no follow-up suggestions, nothing added
before or after. The only exception: if it printed an error, copy the error
and add one line saying what to run instead.
