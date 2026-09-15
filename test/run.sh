#!/bin/sh
# Full test suite. The browser tests need Chrome and a local server.
set -e
cd "$(dirname "$0")"

# Always tear down, even when a test fails or the run is interrupted -- with
# `set -e` a failing test otherwise aborts the script and leaves the http server
# and the headless browser running.
cleanup() {
  # Match on the command line, not the recorded pid: `( ... & echo $! )` records
  # the subshell, so killing it can leave python3 itself orphaned.
  pkill -f 'http.server 8765' 2>/dev/null
  rm -f /tmp/auxetic-test-server.pid
  pkill -f 'remote-debugging-port=9333' 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

echo "=== geometry: the hinges stay joined at every angle ==="
node geom_check.js

echo "\n=== perft: move generation vs published reference counts ==="
node perft.js

echo "\n=== search: tactics and self-play ==="
node ai_test.js

echo "\n=== the twist, in the engine ==="
node twist_test.js

echo "\n=== stop turning, in the engine ==="
node stop_test.js

echo "\n=== the leaderboard, on its own ==="
node leaderboard_test.js

echo "\n=== browser: the game, played through the real UI ==="
(cd .. && python3 -m http.server 8765 >/dev/null 2>&1 &)
sleep 1
node gameplay.js; status=$?
if [ "$status" -eq 0 ]; then
  echo "\n=== browser: the twist, played through the real UI ==="
  node twist_browser.js; status=$?
fi
if [ "$status" -eq 0 ]; then
  echo "\n=== browser: two-player mode ==="
  node hotseat.js; status=$?
fi
if [ "$status" -eq 0 ]; then
  echo "\n=== browser: undo at awkward moments ==="
  node undo.js; status=$?
fi
if [ "$status" -eq 0 ]; then
  echo "\n=== browser: stop turning ==="
  node stop_browser.js; status=$?
fi
if [ "$status" -eq 0 ]; then
  echo "\n=== browser: start screen and leaderboard ==="
  node leaderboard_browser.js; status=$?
fi
exit $status
