# SHOU U RUN Windows 桌面端

WinUI 3 提供原生窗口、工作区切换和文件选择器。WebView2 加载与 Android 版共用的界面、生成算法和上海离线地图。

- 可规划校园周边步行路线、调整跑步参数、导出 GPX 和 FIT。
- Keep 支持短信登录和手动 token。凭证用 Windows 用户范围加密，重启可恢复有效会话，退出登录清除本地副本。
- 在「真实跑步」页导入安卓导出的 JSONL，拟合本地个人配速模型。Windows 使用导入的数据，采集在 Android 上完成。

- 在「真实跑步」页可从 Keep 读取最近最多 20 条可解析的户外跑步进行拟合。
- 在「导出与登录」页可扫描文件导入记录。确认后，逐条将绝对时间提前 15 秒并上传新记录。服务端最终来源标签尚待实测。

## 使用

Windows 10 2004（19041）或更新版本，x64。运行 GitHub Release 中的 `Windows-x64-Setup.exe` 安装程序，在向导中选择安装目录。默认在 `%ProgramFiles%\SHOU U RUN` 自动创建安装目录，安装时需要管理员授权。安装完成后可从桌面快捷方式或开始菜单启动，或在「设置 → 应用」中卸载。升级沿用已安装的目录，卸载保留用户数据。旧版自解压文件可以在确认目录后手动清理。应用自带 .NET 和 Windows App SDK 运行时，界面依赖系统的 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

## 构建

在仓库根目录使用 .NET 8 SDK 和 [Inno Setup 7](https://jrsoftware.org/isdl.php)。将 `ISCC.exe` 加入 PATH，或通过 `-InnoCompiler` 传入完整路径。安装程序会生成到 `local-build`。

```powershell
.\desktop\build-installer.ps1
```
