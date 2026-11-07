#!/usr/bin/env bash
# push.sh —— 只推本仓已提交的 commit；不 add、不 commit、不 force。
# 用法: bash push.sh [--dry-run]   (--dry-run 只打印读数，不写远端)
# 未推送判定只信 ls-remote 的远端 tip，不信本地 upstream 配置。
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"
case "$MODE" in ""|--dry-run) ;; *) echo "用法: bash push.sh [--dry-run]" >&2; exit 2 ;; esac

NAME="$(basename "$PWD")"
BRANCH="$(git branch --show-current)"
if [ -z "$BRANCH" ]; then
  echo "$NAME branch=(detached) state=DETACHED 拒绝推送" >&2
  exit 1
fi
DIRTY="$(git status --porcelain | wc -l | tr -d '[:space:]')"
LOCAL_SHA="$(git rev-parse HEAD)"

# Clash 代理卡 banner 时换直连重试一次（2026-10 实测的已知故障形）。
direct() { git -c core.sshCommand='ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10' "$@"; }
fetch_tip() {
  git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}' && return 0
  direct ls-remote origin "refs/heads/$BRANCH" | awk '{print $1}'
}
REMOTE_SHA="$(fetch_tip)" || { echo "$NAME state=UNREACHABLE ls-remote 失败（代理与直连都不通）" >&2; exit 1; }

STATE=SYNCED; UNPUSHED=0
if [ -z "$REMOTE_SHA" ]; then
  STATE=NEW; UNPUSHED="$(git rev-list --count HEAD)"
elif [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
  if git cat-file -e "$REMOTE_SHA^{commit}" 2>/dev/null && git merge-base --is-ancestor "$REMOTE_SHA" HEAD; then
    STATE=AHEAD; UNPUSHED="$(git rev-list --count "$REMOTE_SHA..HEAD")"
  else
    STATE=DIVERGED
  fi
fi
printf '%s branch=%s local=%s remote=%s unpushed=%s dirty=%s state=%s\n' \
  "$NAME" "$BRANCH" "${LOCAL_SHA:0:8}" "${REMOTE_SHA:0:8}" "$UNPUSHED" "$DIRTY" "$STATE"

[ "$MODE" = "--dry-run" ] && exit 0
case "$STATE" in
  SYNCED) exit 0 ;;
  DIVERGED) echo "!! $NAME 远端与本地分叉（或远端 sha 不在本地），先 fetch+rebase；拒绝推送" >&2; exit 1 ;;
esac
git push origin "HEAD:refs/heads/$BRANCH" || direct push origin "HEAD:refs/heads/$BRANCH"