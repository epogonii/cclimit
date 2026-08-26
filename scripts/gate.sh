#!/bin/sh
# The hot path. This runs before every tool call, so in the normal case — no
# breach — it must cost nothing: two file tests and an exit, no Node process.
#
# The breach file is written by scripts/sink.mjs from the statusline payload. Its
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

# Past this point Node is starting anyway, so the cost of looking for a newer
# copy of the plugin is lost in the noise — and the hot path above, which runs
# before every single tool call, is left exactly as cheap as it was.
#
# A session resolves the plugin directory once, at startup, and keeps using it.
# Without this, an update to the part that decides whether to stop you would sit
# unused until the next restart.
GATE="$(dirname "$0")/gate.mjs"
if [ -z "$CCLIMIT_NO_FORWARD" ]; then
  CACHE="${CCLIMIT_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/plugins/cache"
  # Versions installed before the executables moved out of bin/ are still
  # copies worth handing over to, so both layouts are searched together and
  # the most recently installed one wins whichever shape it has.
  NEWER=$(ls -1dt "$CACHE"/*/cclimit/*/scripts/gate.mjs "$CACHE"/*/cclimit/*/bin/gate.mjs 2>/dev/null | head -1)
  # A half-written update is a directory that exists and does not run, and a
  # gate that cannot run is a gate that stops nothing.
  if [ -n "$NEWER" ] && [ "$NEWER" -nt "$GATE" ] && [ -f "$(dirname "$NEWER")/lib.mjs" ] &&
    node --check "$NEWER" >/dev/null 2>&1; then
    GATE="$NEWER"
  fi
  CCLIMIT_NO_FORWARD=1
  export CCLIMIT_NO_FORWARD
fi

exec node "$GATE" "$@"
