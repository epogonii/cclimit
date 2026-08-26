#!/bin/sh
# The hot path. This runs before every tool call, so in the normal case — no
# breach — it must cost nothing: two file tests and an exit, no Node process.
#
# The breach file is written by bin/sink.mjs from the statusline payload. Its
# existence is the only signal checked here; gate.mjs re-reads the config and
# makes the actual decision, because `/cclimit go` can lift a breach seconds
# before the next statusline render rewrites the file.

DIR="${CCLIMIT_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/cclimit"
BREACH="$DIR/breach.json"

[ -f "$BREACH" ] || exit 0

# Loose outer bound only. A statusline that stopped rendering leaves this file
# behind forever, and an hour-old breach is not worth starting Node for.
# gate.mjs enforces the exact maxStaleSeconds from the config.
find "$BREACH" -mmin -60 2>/dev/null | grep -q . || exit 0

command -v node >/dev/null 2>&1 || exit 0

exec node "$(dirname "$0")/gate.mjs" "$@"
