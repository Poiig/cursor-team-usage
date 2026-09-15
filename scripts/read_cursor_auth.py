#!/usr/bin/env python3
"""只读查询 Cursor state.vscdb 中的 auth 键，供 Node 侧导入本机登录态。"""

from __future__ import annotations

import json
import sqlite3
import sys


KEYS = (
    "cursorAuth/accessToken",
    "cursorAuth/cachedEmail",
    "cursorAuth/refreshToken",
)


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing db path"}))
        return 1
    db_path = sys.argv[1]
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = con.cursor()
        placeholders = ",".join("?" for _ in KEYS)
        cur.execute(
            f"SELECT key, value FROM ItemTable WHERE key IN ({placeholders})",
            KEYS,
        )
        values = {str(k): str(v) for k, v in cur.fetchall() if v is not None}
        con.close()
        print(json.dumps({"values": values}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 — 统一成 JSON 错误给 Node 解析
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
