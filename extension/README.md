# Cursor Team Usage Reporter

把本机 Cursor 登录会话定时上报到 [cursor-team-usage](https://github.com/Poiig/cursor-team-usage) 看板，并支持从看板**一键切换**本机登录账号。

## 使用前

1. 看板已启动；`ACCESS_KEY` 与扩展 `accessKey` 须一致（一键安装会自动注入）。
2. 若扩展不在本机访问看板，看板需监听可达地址，并建议设置 `PUBLIC_BASE_URL`。
3. 无需 Python：读写 `state.vscdb` 用 Cursor 自带的 Node。
4. Cursor **开着**时扩展才会上报（启动后约 8 秒一次，之后每 10 分钟一次，不可配置）；关掉 IDE 即停止（这是正常行为）。

## 安装（推荐）

管理员登录看板 →「用户」→「一键安装插件」：

- 本机 Cursor 已开且本地桥 `:3781` 可用时，直接安装注入密钥后的 VSIX；
- 否则按提示在 PowerShell 执行一行命令（下载 → `cursor --install-extension` → 启动 Cursor）。

安装后执行 **Developer: Reload Window**。扩展启动会对照看板构建号提示更新；也可命令面板「从看板安装/更新插件」。

## 开发者打包

镜像构建会执行 `npm run ext:asset`（仓库根），产出 `assets/reporter-base.vsix` + 构建号；运行时再注入 secret。本地：

```bash
npm run ext:install
npm run ext:asset          # → assets/reporter-base.vsix
# 或仅打扩展包：
npm run ext:package        # → extension/*.vsix
```

开发调试：

```bash
cd extension
npm install
npm run compile    # → dist/extension.js
npm run watch
```

## 设置项

安装后在设置中搜索 `cursorTeamUsage`：

| 键 | 说明 |
| --- | --- |
| `apiBaseUrl` | 看板根地址 |
| `accessKey` | 与服务端 `ACCESS_KEY` 一致 |
| `operatorUsername` | 安装插件的看板用户名；个性化安装包自动注入 |
| `displayName` | 可选显示名；留空用机器名 |
| `localBridgePort` | 本机桥端口，默认 `3781`；`0`=关闭 |

## 本地桥

看板「切换 / 恢复 / 一键安装插件」优先 `POST http://127.0.0.1:3781/...`，Agent 模式也可用。
