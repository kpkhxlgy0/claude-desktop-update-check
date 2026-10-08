# Claude 更新检查

<img src="./icon.png" width="96" height="96" alt="Claude 更新检查图标">

独立的 Claude++ Tweak。在 **Settings → Claude++ → Tweaks → Claude 更新检查 → Configure** 中点击“检查更新（不下载）”，查看当前版本、官方接口返回的可用版本和更新说明。

只在点击按钮时查询版本。打开页面只读取本机版本，不触发网络检查。此 Tweak 不调用 Electron `autoUpdater`，不访问安装包地址，不下载、安装或重启 Claude，也不更改 Windows 更新策略。更新说明按纯文本显示。

## 安装

要求 Windows x64 或 arm64、Claude Desktop MSIX 版本，以及 Claude++ 0.3.4 或更新版本。

在 Claude++ 的 **Tweak Store** 中刷新列表，找到“Claude 更新检查”并安装。安装后打开 **Settings → Claude++ → Tweaks → Claude 更新检查 → Configure**，或左侧 **TWEAKS → Claude 更新检查**。

源码与版本记录：[GitHub 仓库](https://github.com/kpkhxlgy0/claude-desktop-update-check) · [发布版本](https://github.com/kpkhxlgy0/claude-desktop-update-check/releases)。商店固定安装已审核的提交，GitHub Release 用于查看版本和变更。

## 开发与验证

在此目录运行：

```powershell
npm test
$tweakPath = (Get-Location).Path
node "$env:USERPROFILE\.claude-plusplus\source\bin\claudeplusplus.js" validate-tweak $tweakPath
node "$env:USERPROFILE\.claude-plusplus\source\bin\claudeplusplus.js" dev $tweakPath --no-watch
```

`dev --no-watch` 使用 Claude++ 标准开发链接加载本目录，并通知正在运行的 Runtime 重载。可以在 Tweaks 列表中关闭本 Tweak。

项目不需要构建，也没有第三方运行时依赖。测试需要 Node.js 24 或更新版本。

## 查询与数据

- 版本信息来自 Anthropic 官方 Windows MSIX 更新元数据接口，支持 x64 和 arm64。
- 接口要求 `device_id`。首次手动查询时生成一个专用于此 Tweak 的随机标识并保存在其 Main storage 中，不读取 Claude 的账号、令牌或原生设备标识。
- 请求只发送该随机标识、当前 Claude 版本和 Windows 版本；结果可能受官方分批发布影响。
- 只解析版本号及更新说明，忽略元数据中的安装包 URL。请求限制时长和响应大小，拒绝重定向与非 JSON 响应。
- 网络错误或缺少版本信息会明确显示，不会误报为已是最新版本。
- 此 Tweak 不负责禁用 Claude 的原生更新器。如需禁止原生检查和自动安装，Windows 机器策略 `HKLM\SOFTWARE\Policies\Claude\disableAutoUpdates` 应保持为 `DWORD 1`。

源码：`index.js` 管理 Tweak 生命周期和设置页；`update-check.cjs` 负责仅查询元数据；`test/` 为行为测试。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。此项目为独立社区 Tweak，不隶属于 Anthropic。
