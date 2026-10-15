#!/usr/bin/env bash
# macOS 下载已构建的 Reporter VSIX 并安装到 Cursor。
#
# 用法：
#   ./scripts/install-reporter.sh
#   ./scripts/install-reporter.sh https://example.com/reporter.vsix

set -euo pipefail

url="${1:-${CTU_VSIX_URL:-https://github.com/Poiig/cursor-team-usage/releases/download/extension-latest/cursor-team-usage-reporter.vsix}}"
cli="$(command -v cursor || true)"
if [[ -z "$cli" ]]; then
  echo '未找到 cursor CLI。请在 Cursor 命令面板执行 Shell Command: Install "cursor" command in PATH。' >&2
  exit 1
fi

vsix="${TMPDIR:-/tmp}/cursor-team-usage-reporter.vsix"
curl -fL "$url" -o "$vsix"
"$cli" --install-extension "$vsix" --force
open -a Cursor
