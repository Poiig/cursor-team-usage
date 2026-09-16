# Cursor Team Usage

本地 / 内网运行的 **Cursor 多账号用量看板**：汇总多个账号的额度、花费与请求明细。不是官方 Team Admin。

> 仓库：https://github.com/Poiig/cursor-team-usage

## 截图

**账号列表** — 紧凑卡片、额度进度、今日 / 昨日 / 近 30 天花费

![列表页](docs/screenshots/list.png)

**账号详情** — 图表 + 与官方同源的逐次请求表

![详情页](docs/screenshots/detail.png)

## 功能

| 能力 | 说明 |
| --- | --- |
| 多账号 | 网页添加 / 本机导入 / 粘贴 Token；或用 Reporter 扩展自动上报 |
| 用量总览 | Total / Cursor Models / Other Models；剩余额度、额度重置、Token 有效至 |
| 详情页 | Grok Bot、日花费 / tokens 图、Top models、请求明细（可 Export CSV） |
| 隐私模式 | 列表邮箱脱敏 |
| 控制台 | 固定账号 `admin`，默认密码 `admin`，首次登录强制改密 |
| 配置 | 仓库根目录 `.env`（模板 `.env.example`），**无网页设置页**，改完重启 |
| 存储 | 默认本地 SQLite（`data/app.sqlite`，含名册与控制台账号）；可选 PostgreSQL；`file` 为遗留 JSON |
| 刷新 | 服务端按 `AUTO_REFRESH_SEC` 后台定时刷新（默认 30 分钟）；列表可手动「更新模型」 |

## 快速开始

需要 **Node.js 20+**。依赖安装使用淘宝镜像（见根目录 / `extension/.npmrc`）。

```bash
cp .env.example .env   # Windows: copy .env.example .env
npm install
npm start
```

浏览器打开 http://127.0.0.1:3780 ，用 `admin` / `admin` 登录并立刻改密。

```bash
npm run dev    # 热重载
```

### 服务配置

编辑根目录 `.env` 后**重启进程**。进程环境变量优先于 `.env` 文件。

| 变量 | 说明 |
| --- | --- |
| `STORE_DRIVER` | `sqlite`（默认）、`postgres`，或遗留 `file` |
| `SQLITE_PATH` | SQLite 库路径，默认 `data/app.sqlite` |
| `DATABASE_URL` | PG 连接串；也可用 `PGHOST` 等拆分变量 |
| `ACCESS_KEY` | Reporter 扩展上报密钥；默认 `ctu-change-me`（**生产请改**）；显式设空则关闭上报 |
| `AUTO_REFRESH_SEC` | 服务端定时刷全员用量（秒），默认 `1800`（30 分钟），`0`=关 |
| `SESSION_SECRET` | 登录 Cookie 签名；空则首次启动自动生成并写入 `.env` |
| `HOST` / `PORT` | 监听地址端口（默认 `127.0.0.1:3780`） |

启动时自动建表（`members` + `console_admin`）。

PostgreSQL 示例（写入 `.env`）：

```env
STORE_DRIVER=postgres
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/cursor_team_usage
```

## Docker

直接拉取 GHCR 镜像，**不在本机构建**：

```bash
cp .env.example .env   # 按需填写 ACCESS_KEY 等
docker compose pull
docker compose up -d
```

打开 http://localhost:3780 。数据在 `./data`（已 gitignore）。

```bash
# 指定某次 CI 构建的 commit sha
# 改 docker-compose.yml 中 image 标签，或：
docker pull ghcr.io/poiig/cursor-team-usage:<commit-sha>
```

包页：https://github.com/Poiig/cursor-team-usage/pkgs/container/cursor-team-usage

若 `pull` 失败，先登录 GHCR（Token 需 `read:packages`）：

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME
```

仅本机访问时可改 ports 为 `"127.0.0.1:3780:3780"`。`docker-compose.yml` 里可取消注释 Postgres。

## 如何录入账号

三种方式，可混用：

| 方式 | 适用 | 做法 |
| --- | --- | --- |
| 本机导入 | 看板跑在装了 Cursor 的同一台机器 | 网页点「本机导入」（读 `state.vscdb`，需本机 Python 3） |
| 粘贴 Token | 任意机器临时加号 | Cookie 里复制 `WorkosCursorSessionToken` |
| **Reporter 扩展（多机推荐）** | 各开发机自动续报 | `install-reporter.ps1` 下载成品安装，配置看板地址与 `accessKey` |

### Token 能用多久？

落盘的是 Cursor access JWT，有过期时间（列表显示「Token 有效至」）。看板**不会**自己刷新 Token。

- **本机导入 / 粘贴**：过期后需再导入或再粘贴。Cursor IDE 保持登录时会把新 Token 写回本地库，再点一次「本机导入」即可。
- **Reporter 扩展**：Cursor 开着时按间隔把当前会话上报到看板，过期前一般会带上续期后的 Token；关机或未登录期间不会续。

### Reporter 扩展

1. 服务端 `.env` 设好 `ACCESS_KEY`，并视需要 `HOST=0.0.0.0` 供局域网访问。
2. 各开发机安装 Reporter 扩展（下载成品，无需本机构建）：

```powershell
# 默认地址
irm https://raw.githubusercontent.com/Poiig/cursor-team-usage/master/scripts/install-reporter.ps1 | iex

# 指定 VSIX 下载地址
iex "& { $(irm https://raw.githubusercontent.com/Poiig/cursor-team-usage/master/scripts/install-reporter.ps1) } -Url 'https://example.com/reporter.vsix'"
```

安装后 **Developer: Reload Window**。默认 VSIX：

`https://github.com/Poiig/cursor-team-usage/releases/download/extension-latest/cursor-team-usage-reporter.vsix`

3. 设置里填写（与看板一致）：

| 键 | 说明 |
| --- | --- |
| `cursorTeamUsage.apiBaseUrl` | 如 `http://192.168.1.10:3780` |
| `cursorTeamUsage.accessKey` | 与 `.env` 的 `ACCESS_KEY` 相同（默认均为 `ctu-change-me`，生产请改） |
| `cursorTeamUsage.displayName` | 可选；**仅新建时**用作显示名（留空则机器名）；已有账号不覆盖 |
| `cursorTeamUsage.autoReportIntervalMinutes` | 启动先报一次，之后按间隔（分钟）；默认 30；`0`=仅手动 |

打包发布时自行改 `extension/package.json` 默认值后 `npm run ext:package`，再把 VSIX 放到上述地址对应位置。

详情见 [extension/README.md](./extension/README.md)。

## 安全

- 会话 Token **等同登录态**，仅本机或可信内网
- 默认监听 `127.0.0.1`；对外请自行加反向代理与访问控制
- `.env` 与 `data/`（含 `app.sqlite`）已忽略，勿提交
- 「导出」含完整 Token，自行保管

## 数据来源

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
src/                 服务端与 Cursor API
public/              列表 / 详情 / 登录页
extension/           Reporter 扩展（打 VSIX）
.env.example         配置模板 → 复制为 .env
docker-compose.yml   拉取 ghcr.io/poiig/cursor-team-usage
scripts/             本机读 state.vscdb 等
docs/screenshots/    README 截图
data/                运行时数据（app.sqlite，勿提交）
```

## 参考

- [iair0007/cursor-usage](https://github.com/iair0007/cursor-usage)
- [robinebers/openusage](https://github.com/robinebers/openusage)

## License

[MIT](./LICENSE)
