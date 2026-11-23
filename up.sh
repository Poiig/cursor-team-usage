#!/usr/bin/env bash
# 本机用 Node 直接启动看板（不走容器）。
# 用法：./up.sh [--dev]
#   默认 npm start；--dev 为 npm run dev（--watch 热重载）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MODE=start

for arg in "$@"; do
  case "$arg" in
    --dev) MODE=dev ;;
    -h|--help)
      echo "用法: ./up.sh [--dev]"
      echo "  默认  npm start"
      echo "  --dev npm run dev（热重载）"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。需要 Node.js 20+" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "缺少 .env。可参考 .env.example，或从 6.80 /opt/cursor-team-usage/.env 拷行为配置（PUBLIC_BASE_URL 改本机）。" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "==> npm install"
  npm install
fi

mkdir -p data

echo "==> npm run ${MODE}  →  http://127.0.0.1:3780"
exec npm run "$MODE"
