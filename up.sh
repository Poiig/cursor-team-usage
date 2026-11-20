#!/usr/bin/env bash
# 本机用 Apple Container（brew: container）源码构建并启动看板。
# 用法：./up.sh [--build] [--no-cache]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

NAME=cursor-team-usage
IMAGE=cursor-team-usage:local
NEED_BUILD=0
NO_CACHE=""

for arg in "$@"; do
  case "$arg" in
    --build) NEED_BUILD=1 ;;
    --no-cache) NEED_BUILD=1; NO_CACHE=--no-cache ;;
    -h|--help)
      echo "用法: ./up.sh [--build] [--no-cache]"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

if ! command -v container >/dev/null 2>&1; then
  echo "未找到 container CLI。请先: brew install container && container system start" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "缺少 .env。可参考 .env.example，或从 6.80 /opt/cursor-team-usage/.env 拷行为配置（PUBLIC_BASE_URL 改本机）。" >&2
  exit 1
fi

mkdir -p data

if ! container image list 2>/dev/null | grep -q "cursor-team-usage.*local"; then
  NEED_BUILD=1
fi

if [[ "$NEED_BUILD" -eq 1 ]]; then
  echo "==> container build ${IMAGE}"
  # shellcheck disable=SC2086
  container build $NO_CACHE -t "$IMAGE" -f Dockerfile .
fi

if container list --all 2>/dev/null | grep -q "$NAME"; then
  echo "==> 停止并删除旧容器 $NAME"
  container stop "$NAME" 2>/dev/null || true
  container delete "$NAME" 2>/dev/null || true
fi

echo "==> 启动 $NAME (3780)"
# Apple container：bind 只接受目录；--env-file 也会误当成目录挂载。从 .env 展开成 -e。
ENV_ARGS=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  ENV_ARGS+=(-e "$line")
done < .env

container run -d --name "$NAME" \
  -p 3780:3780 \
  "${ENV_ARGS[@]}" \
  -e HOST=0.0.0.0 \
  -e PORT=3780 \
  --mount "type=bind,source=${ROOT}/data,target=/app/data" \
  "$IMAGE"

echo "==> 就绪: http://127.0.0.1:3780"
container list | grep -E "NAME|$NAME" || container list
