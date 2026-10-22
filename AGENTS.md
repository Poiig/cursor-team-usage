# 给代理的约定

## 插件版本

改了会打进安装包的插件代码（`extension/src/`、`extension/package.json`、打包配置，以及 `scripts/build-extension-asset.mjs`）时，必须同时把 `extension/package.json` 和 `extension/package-lock.json` 的 `version` 升一档。

没改插件就不要动版本号。

发布和「要不要升级」只认这个版本号。不要用 git sha、构建时间或内容哈希充当版本。
