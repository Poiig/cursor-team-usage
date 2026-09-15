# 席位用量 · Cursor Team Usage

团队主管查看**多名个人版** Cursor 成员用量与额度的本地看板。

个人版没有 Team Admin API，无法用一把管理员密钥拉全队数据。本工具为每位成员保存一份 `WorkosCursorSessionToken`，由本机（或 Docker）服务汇总展示额度进度、周期花费与模型用量。

## 截图

列表页（多账号紧凑卡片，Grok Bot 仅在详情页展示）：

![列表页](docs/screenshots/list.png)

账号详情（进度条、日花费 / tokens 图表、Top models）：

![详情页](docs/screenshots/detail.png)

## 能看到什么

- 团队汇总：席位数、账单周期花费合计、请求合计、临近额度人数
- 每人：套餐、请求额度（used/limit）、周期花费 / 硬上限、重置时间、同步状态
- 列表：Total usage / Cursor Models / Other Models，以及 Today · Yesterday · Last 30 Days
- 详情：另含 Grok Bot usage、日花费与 tokens 趋势、周期 Top models
- 告警：额度或花费 ≥80% 标黄，≥95% 标红

## 快速开始

需要 Node.js 18+。

```bash
npm start
```

浏览器打开 http://127.0.0.1:3780

开发热重载：

```bash
npm run dev
```

可选环境变量：`HOST`（默认 `127.0.0.1`）、`PORT`（默认 `3780`）。

## Docker

```bash
docker compose up -d --build
```

浏览器打开 http://localhost:3780 。名册与 Token 持久化在 `./data`（已 gitignore，勿提交）。

仅本机访问时可把 `docker-compose.yml` 中 ports 改成：

```yaml
ports:
  - "127.0.0.1:3780:3780"
```

单独构建镜像：

```bash
docker build -t cursor-team-usage .
docker run --rm -p 3780:3780 -v "%cd%/data:/app/data" -e HOST=0.0.0.0 cursor-team-usage
```

## 成员如何授权

### 本机一键导入（推荐给主管自己）

看板读取 Cursor 本地库 `state.vscdb` 中的 `cursorAuth/accessToken`，无需复制 Cookie。空状态页或添加对话框里点「从本机 Cursor 导入」即可。

Windows 需已安装 **Python 3**（或 `sqlite3` CLI），用于只读查询可能高达数 GB 的状态库。

### 其他同事（个人版）

个人版没有 Team Admin API。可选：

1. 同事在自己电脑跑本工具 →「从本机 Cursor 导入」看自己的用量；或
2. 从 [cursor.com/dashboard](https://cursor.com/dashboard) Cookie 复制 `WorkosCursorSessionToken` 交给主管粘贴

### Token 是否长期有效？

**不是永久。** 本地拿到的是 JWT access token，带 `exp`。Cursor IDE 会用 refresh token 续期并写回数据库，所以「本机导入」在 Cursor 保持登录时通常很长一段都能用；浏览器 Cookie / 过期 JWT 失效后需重新导入或粘贴。

## 安全说明

- 会话 Token **等同登录态**，只应在本机/内网可信环境使用
- 默认只监听 `127.0.0.1`，勿直接暴露到公网
- 名册保存在本地 `data/members.json`（已在 `.gitignore`，**切勿提交**）
- 前端接口只返回遮蔽后的 Token 后缀，完整值不出本机
- Docker 请将 `./data` 挂为 volume，且不要把含真实 Token 的目录推到公开仓库

## 原理简述

服务端用每人的 cookie 调用 cursor.com 非官方接口：

| 用途 | 接口 |
| --- | --- |
| 账号身份 | `GET /api/auth/me` |
| 套餐 | `GET /api/auth/stripe` |
| **套餐用量百分比** | `GET /api/usage-summary`（`totalPercentUsed` / `autoPercentUsed` / `apiPercentUsed`） |
| **周期用量（Connect）** | `POST api2.cursor.sh/.../GetCurrentPeriodUsage` |
| 请求额度（旧） | `GET /api/usage?user=…` |
| 花费硬上限 | `POST /api/dashboard/get-hard-limit` |
| 周期用量事件 | `POST /api/dashboard/get-filtered-usage-events` |
| Grok Bot | Connect `GetSandUsageStatus` |

这些接口可能随 Cursor 变更；失败时成员卡片会显示错误信息。

## 目录

```
src/              HTTP 服务、Cursor API 客户端、名册持久化
public/           看板前端
scripts/          本机读 state.vscdb 等辅助脚本
docs/screenshots/ README 截图
data/             运行时生成（成员名册与 Token，勿提交）
```

## 参考项目

本仓库在接口选型与面板指标思路上参考了以下开源项目（致谢）：

- [iair0007/cursor-usage](https://github.com/iair0007/cursor-usage) — 个人会话用量看板
- [robinebers/openusage](https://github.com/robinebers/openusage) — 用量面板指标与 Connect RPC 用法

## License

[MIT](./LICENSE)
