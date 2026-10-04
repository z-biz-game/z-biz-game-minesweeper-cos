#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, scripted scenarios.
#
#   ./tools/verify.sh                 # engine + gen + play + hint + save/resume + layout
#   SCENARIOS="play hint" ./tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-minesweeper-cos/ ./tools/verify.sh
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${CDP_PORT:-9344}; if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo ":$PORT is already LISTENING — a sibling gate or an orphan Chrome holds it; attaching there reads someone else's browser. Wait for it to finish, or rerun with CDP_PORT=<a free port>." >&2; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true; exit 6; fi  # 一机一台：撞在同一个默认口上时不报错的是 Chrome，报错的是绿——先让路再开闸
# 5173 is Xcode/ashen-ring's default and a long-lived server there will happily serve a
# *different* app, so this harness deliberately uses its own port.
HTTP=${HTTP_PORT:-5217}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
SPID=0
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$HTTP" >/tmp/minesweeper-server.log 2>&1 &
  SPID=$!
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# Pre-flight: prove the bytes we are about to test are this app's, not some other repo's
# index.html served on the same port.
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/minesweeper-server.log)" >&2; exit 2 ;; esac
echo "$SERVED" | grep -qi minesweeper || { echo "port $HTTP is serving a different app, not minesweeper" >&2; exit 2; }

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,900 --no-first-run --no-default-browser-check about:blank >/tmp/minesweeper-chrome.log 2>&1 &
CPID=$!
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT" >&2; exit 3; }

export CDP_PORT=$PORT
export BASE_URL=$BASE
cd "$HERE"
node tools/playtest.cjs open "$BASE" | head -5

BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.cjs eval "window.minesweeper?window.minesweeper.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot: minesweeper $BOOT at $BASE"
[ "$BOOT" = "nope" ] && { echo "window.minesweeper never appeared at $BASE" >&2; exit 4; }

FAILED=0
for s in ${SCENARIOS:-engine gen play hint save resume layout}; do
  echo "=== $s ==="
  node tools/playtest.cjs scenario "$s" 2>/tmp/minesweeper-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/minesweeper-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-46s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" || FAILED=1
  if [ -s /tmp/minesweeper-$s.console.log ]; then
    echo "  --- console ---"
    sed 's/^/  /' /tmp/minesweeper-$s.console.log | tail -12
  fi
done

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  for shot in menu board win; do
    case $shot in
      menu) node tools/playtest.cjs eval "window.minesweeper.show('menu');'ok'" nonav >/dev/null 2>&1 ;;
      board) node tools/playtest.cjs eval "window.minesweeper.begin({tier:'scout',seed:'shot-board'}).then(()=>{const g=window.minesweeper.game;window.minesweeper.dig(g.puzzle.start);for(let i=0;i<14;i++)window.minesweeper.useHint();})" nonav >/dev/null 2>&1 ;;
      win) node tools/playtest.cjs eval "window.minesweeper.begin({tier:'trainee',seed:'shot-win'}).then(()=>window.minesweeper.solveWithLogic())" nonav >/dev/null 2>&1 ;;
    esac
    sleep 1.4
    node tools/playtest.cjs shot tools/shots/$shot-$SHOTS.png >/dev/null
  done
  echo "shots: $(ls tools/shots/*-$SHOTS.png | tr '\n' ' ')"
fi

kill $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
