#!/usr/bin/env python3
"""把看板下发的会话写入本机 Cursor state.vscdb，供一键切换账号使用。"""

from __future__ import annotations

import json
import sqlite3
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: write_cursor_auth.py <db_path> <payload.json>"}))
        return 1
    db_path = sys.argv[1]
    payload_path = sys.argv[2]
    try:
        with open(payload_path, encoding="utf-8") as f:
            payload = json.load(f)
        if not isinstance(payload, dict):
            raise ValueError("payload must be object")

        # 只允许写入已知的 auth 键，避免脚本被滥用改其它配置
        allowed = {
            "cursorAuth/accessToken": payload.get("accessToken"),
            "cursorAuth/refreshToken": payload.get("refreshToken") or payload.get("accessToken"),
            "cursorAuth/cachedEmail": payload.get("cachedEmail"),
            "cursorAuth/stripeMembershipAuthId": payload.get("stripeMembershipAuthId"),
            "cursorAuth/cachedSignUpType": payload.get("cachedSignUpType"),
        }
        pairs = [(k, v) for k, v in allowed.items() if isinstance(v, str) and v]

        if not any(k.endswith("accessToken") for k, _ in pairs):
            raise ValueError("missing accessToken")

        con = sqlite3.connect(db_path)
        cur = con.cursor()
        for key, value in pairs:
            # ItemTable.key 一般是主键；不用 ON CONFLICT，兼容部分旧库
            cur.execute("SELECT 1 FROM ItemTable WHERE key = ?", (key,))
            if cur.fetchone():
                cur.execute("UPDATE ItemTable SET value = ? WHERE key = ?", (value, key))
            else:
                cur.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)", (key, value))
        con.commit()
        con.close()
        print(json.dumps({"ok": True, "written": [k for k, _ in pairs]}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 — 统一成 JSON 错误给 Node 解析
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
