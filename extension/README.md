# Cursor Team Usage Reporter

把本机 Cursor 登录会话定时上报到 [cursor-team-usage](https://github.com/Poiig/cursor-team-usage) 看板，用于多机自动续报 Token。

## 使用前

1. 看板已启动；默认 Access Key 为 `ctu-change-me`（与扩展默认一致）。**生产环境请同时修改**服务端 `.env` 的 `ACCESS_KEY` 与扩展设置。
2. 若扩展不在本机访问看板，看板需监听可达地址（如 `HOST=0.0.0.0`）。
3. 本机已登录 Cursor，并安装 **Python 3**（只读 `state.vscdb`）。

## 安装（推荐）

不需要本机构建。PowerShell 从固定地址下载成品 VSIX 并安装到 Cursor：

```powershell
# 默认地址
irm https://raw.githubusercontent.com/Poiig/cursor-team-usage/master/scripts/install-reporter.ps1 | iex

# 指定 VSIX 下载地址
iex "& { $(irm https://raw.githubusercontent.com/Poiig/cursor-team-usage/master/scripts/install-reporter.ps1) } -Url 'https://example.com/reporter.vsix'"
```

或克隆仓库后：

```powershell
.\scripts\install-reporter.ps1
.\scripts\install-reporter.ps1 -Url https://example.com/reporter.vsix
```

默认 VSIX：

`https://github.com/Poiig/cursor-team-usage/releases/download/extension-latest/cursor-team-usage-reporter.vsix`

安装后执行 **Developer: Reload Window**。

## 开发者打包

仓库根目录（需要 Node 20+）。打包前可按环境改 `package.json` 里的默认 `apiBaseUrl` / `accessKey`，再：

```bash
npm run ext:install
npm run ext:package
```

生成 `extension/cursor-team-usage-reporter-*.vsix`，自行放到上述下载地址对应位置。

开发调试：

```bash
cd extension
npm install
npm run compile    # → dist/extension.js
npm run watch
```

## 设置项

安装后在设置中搜索 `cursorTeamUsage`：

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `apiBaseUrl` | 看板根 URL（无末尾 `/`） | `http://127.0.0.1:3780` |
| `accessKey` | 与看板 `ACCESS_KEY` 一致 | `ctu-change-me`（生产请改） |
| `displayName` | 仅**新建**时作显示名；已有账号上报不覆盖人工改名 | 空 → **用本机机器名** |
| `autoReportIntervalMinutes` | 自动上报间隔（分钟）；**启动先报一次**，之后按此间隔；`0`=仅手动 | `30` |
| `refreshAfterReport` | 上报后让看板立刻刷该账号用量 | `true` |

> 已有账号再次上报只更新会话 Token；`displayName` / `hostname` 不会被覆盖。

要把 `accessKey` / `apiBaseUrl` 打进 VSIX：打包前改 `package.json` → `contributes.configuration.properties` 里对应项的 `default`。公开仓库不要提交真实密钥。

## 行为说明

- 扩展激活约 8 秒后自动上报一次，之后按间隔执行（默认 30 分钟）。
- 命令：`Cursor Team Usage: 立即上报本机账号` / `查看上报状态`；状态栏有 `CTU`。
- 上报接口：`POST /api/agent/report`，请求头 `X-Access-Key`。
- 看板落盘的仍是 JWT；扩展只是在 Cursor 开着时把本地续期后的 Token 推上去，**关机期间不会续**。

## 上报体示例

```http
POST /api/agent/report
X-Access-Key: <accessKey>
Content-Type: application/json

{
  "sessionToken": "...",
  "displayName": "<机器名或自定义>",
  "email": "...",
  "hostname": "<机器名>",
  "refresh": true
}
```
