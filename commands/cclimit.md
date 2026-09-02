---
description: Show or change where plan usage stops Claude Code
argument-hint: "[<percent> | 5h <percent> | 7d <percent> | ceiling 5h|7d <percent>|off | notice 5h|7d <percent>|off | action stop|ask|warn | downgrade sonnet|haiku|off | alert bell|notify|off | config | go | on | off | install | uninstall]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cclimit.mjs" $ARGUMENTS`

The command above already did the work and its output is the answer. Reply
with that text exactly as printed — same words, same line breaks, no code
fence, no summary, no rewording, no follow-up suggestions, nothing added
before or after. The only exception: if it printed an error, copy the error
and add one line saying what to run instead.
