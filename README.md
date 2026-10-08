# Claude 更新检查

<img src="./icon.png" width="96" height="96" alt="Claude 更新检查图标">

独立的 Claude++ Tweak。在 **Settings → Claude++ → Tweaks → Claude 更新检查 → Configure** 中点击“检查更新（不下载）”，查看当前版本、官方接口返回的可用版本和更新说明。

只在点击按钮时查询版本。打开页面只读取本机版本，不触发网络检查。此 Tweak 不调用 Electron `autoUpdater`，不访问安装包地址，不下载、安装或重启 Claude，也不更改 Windows 更新策略。更新说明按纯文本显示。

## 安装

要求 Windows x64 或 arm64、Claude Desktop MSIX 版本，以及 Claude++ 0.3.4 或更新版本。

在 Claude++ 的 **Tweak Store** 中刷新列表，找到“Claude 更新检查”并安装。安装后打开 **Settings → Claude++ → Tweaks → Claude 更新检查 → Configure**，或左侧 **TWEAKS → Claude 更新检查**。

源码与版本记录：[GitHub 仓库](https://github.com/kpkhxlgy0/claude-desktop-update-check) · [发布版本](https://github.com/kpkhxlgy0/claude-desktop-update-check/releases)。商店固定安装已审核的提交，GitHub Release 用于查看版本和变更。

### 从源码安装

已安装 Claude++ 时，在可信的源码目录中使用 PowerShell 7.2 或更新版本运行：

```powershell
pwsh -NoProfile -File .\Inject-ClaudePlusPlus.ps1 -CheckOnly
pwsh -NoProfile -File .\Inject-ClaudePlusPlus.ps1
```

脚本只在当前用户的 Claude++ Tweaks 目录中创建指向本源码目录的 Junction；重复运行不会重复安装。运行后重启 Claude 即可加载。

移除本源码目录的开发链接：

```powershell
pwsh -NoProfile -File .\Uninject-ClaudePlusPlus.ps1 -CheckOnly
pwsh -NoProfile -File .\Uninject-ClaudePlusPlus.ps1
```

`-CheckOnly` 只检查状态。安装脚本可以将指向其他源码位置的同名 Junction 改为当前目录；卸载脚本只移除指向当前源码的 Junction，不删除源码、设置或其他 Tweak。两者都拒绝处理真实目录、符号链接和其他不支持的重解析点，卸载也会拒绝指向其他源码的链接。商店安装的副本应在商店中管理，不使用这组开发链接脚本。

## 开发与验证

在此目录运行：

```powershell
npm test
npm run test:windows
$tweakPath = (Get-Location).Path
node "$env:USERPROFILE\.claude-plusplus\source\bin\claudeplusplus.js" validate-tweak $tweakPath
```

Windows 链接测试使用系统临时目录中的隔离 APPDATA，不改动当前用户的开发链接。可以在 Tweaks 列表中关闭本 Tweak。

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
