#!/usr/bin/env python3
"""把看板 ACCESS_KEY / apiBaseUrl / build 注入 VSIX 内 package.json 默认值。"""

from __future__ import annotations

import argparse
import json
import zipfile
from io import BytesIO


def patch_package_json(
    raw: bytes,
    access_key: str,
    api_base_url: str,
    operator_username: str,
    operator_proof: str,
    build: str,
) -> bytes:
    pkg = json.loads(raw.decode("utf-8"))
    props = (
        pkg.get("contributes", {})
        .get("configuration", {})
        .get("properties", {})
    )
    if "cursorTeamUsage.accessKey" in props:
        props["cursorTeamUsage.accessKey"]["default"] = access_key
    if "cursorTeamUsage.apiBaseUrl" in props:
        props["cursorTeamUsage.apiBaseUrl"]["default"] = api_base_url.rstrip("/")
    if "cursorTeamUsage.operatorUsername" in props:
        props["cursorTeamUsage.operatorUsername"]["default"] = operator_username
    if "cursorTeamUsage.operatorProof" in props:
        props["cursorTeamUsage.operatorProof"]["default"] = operator_proof
    # 供扩展检查更新比对
    pkg["ctuBuild"] = build
    return (json.dumps(pkg, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src_vsix")
    ap.add_argument("dst_vsix")
    ap.add_argument("--access-key", required=True)
    ap.add_argument("--api-base-url", required=True)
    ap.add_argument("--operator-username", default="")
    ap.add_argument("--operator-proof", default="")
    ap.add_argument("--version", default="0.0.0")
    ap.add_argument("--build", default="local")
    args = ap.parse_args()

    build_info = json.dumps(
        {
            "version": args.version,
            "build": args.build,
            "apiBaseUrl": args.api_base_url.rstrip("/"),
            "accessKey": args.access_key,
            "operatorUsername": args.operator_username,
            "operatorProof": args.operator_proof,
        },
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")

    out_buf = BytesIO()
    with zipfile.ZipFile(args.src_vsix, "r") as zin, zipfile.ZipFile(
        out_buf, "w", compression=zipfile.ZIP_DEFLATED
    ) as zout:
        wrote_build_info = False
        for info in zin.infolist():
            data = zin.read(info.filename)
            name = info.filename.replace("\\", "/")
            if name == "extension/package.json" or name == "package.json":
                data = patch_package_json(
                    data,
                    args.access_key,
                    args.api_base_url,
                    args.operator_username,
                    args.operator_proof,
                    args.build,
                )
            if name == "extension/build-info.json":
                data = build_info
                wrote_build_info = True
            # 保留原始压缩信息以外的文件名/时间
            new_info = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
            new_info.compress_type = zipfile.ZIP_DEFLATED
            new_info.external_attr = info.external_attr
            zout.writestr(new_info, data)
        if not wrote_build_info:
            zout.writestr("extension/build-info.json", build_info)

    with open(args.dst_vsix, "wb") as f:
        f.write(out_buf.getvalue())
    print(json.dumps({"ok": True, "build": args.build}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
