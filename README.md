# Cursor Team Usage

本地运行的 **Cursor 多账号用量看板**：在一个页面里管理多个账号的额度、花费与请求明细。

> 仓库：https://github.com/Poiig/cursor-team-usage

每个账号各自保存一份会话 Token，本机汇总展示；适合自己有多套账号，或需要并排盯用量的场景。无需 Cursor Team Admin。

## 截图

**账号列表** — 紧凑卡片、额度进度、今日 / 昨日 / 近 30 天花费

![列表页](docs/screenshots/list.png)

**账号详情** — 图表 + 与官方同源的逐次请求表

![详情页](docs/screenshots/detail.png)

## 功能

| 能力 | 说明 |
| --- | --- |
| 多账号 | 添加 / 编辑 / 删除，本机一键导入或粘贴 Token |
| 用量总览 | Total / Cursor Models / Other Models，剩余额度与重置倒计时 |
| 详情页 | 独立页面：Grok Bot、日花费 / tokens 图、Top models |
| 请求明细 | 对齐 [官方 Usage](https://cursor.com/dashboard/usage)：Date · Type · Model · Tokens · Cost，可 Export CSV |
| 隐私模式 | 列表邮箱脱敏，方便投屏 |
| 导出 | 账号列表 JSON（含 Token，仅本机备份） |
| 设置 | 自动刷新频率本地保存 |
| 告警色 | 用量 ≥80% 标黄，≥95% 标红 |

## 快速开始

需要 **Node.js 18+**。

```bash
npm start
```

打开 http://127.0.0.1:3780

```bash
npm run dev    # 热重载
```

环境变量：`HOST`（默认 `127.0.0.1`）、`PORT`（默认 `3780`）。

## Docker

```bash
docker compose up -d --build
```

打开 http://localhost:3780 。账号数据在 `./data`（已 gitignore）。

仅本机访问时可改 ports：

```yaml
ports:
  - "127.0.0.1:3780:3780"
```

或：

```bash
docker build -t cursor-team-usage .
docker run --rm -p 3780:3780 -v "%cd%/data:/app/data" -e HOST=0.0.0.0 cursor-team-usage
```

## 添加账号

**本机导入（推荐）**  
读取 Cursor `state.vscdb` 中的 `cursorAuth/accessToken`。Windows 需安装 Python 3（或 `sqlite3` CLI）。

**粘贴 Token**  
从 [cursor.com/dashboard](https://cursor.com/dashboard) Cookie 复制 `WorkosCursorSessionToken`。

Token 是 JWT，会过期；Cursor 保持登录时本机导入通常可长期用，失效后重新导入或粘贴即可。

## 安全

- Token **等同登录态**，仅建议本机 / 可信内网使用
- 默认监听 `127.0.0.1`，不要直接暴露公网
- `data/members.json` 已忽略，**勿提交**
- 「导出」会带出完整 Token，文件请自行保管

## 数据从哪来

调用 cursor.com 非官方接口（可能随官方变更）：

| 用途 | 接口 |
| --- | --- |
| 身份 | `GET /api/auth/me` |
| 套餐 | `GET /api/auth/stripe` |
| 用量百分比 | `GET /api/usage-summary` |
| 周期用量 | Connect `GetCurrentPeriodUsage` |
| 请求事件 | `POST /api/dashboard/get-filtered-usage-events` |
| 花费上限 | `POST /api/dashboard/get-hard-limit` |
| Grok Bot | Connect `GetSandUsageStatus` |

## 目录

```
src/               服务端与 Cursor API
public/            列表 index.html · 详情 detail.html
scripts/           本机读 state.vscdb 等
docs/screenshots/  README 截图
data/              运行时名册（勿提交）
```

## 参考

接口与面板指标思路参考：

- [iair0007/cursor-usage](https://github.com/iair0007/cursor-usage)
- [robinebers/openusage](https://github.com/robinebers/openusage)

## License

[MIT](./LICENSE)
