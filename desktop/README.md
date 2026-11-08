# SHOU U RUN Windows 桌面端

WinUI 3 提供原生窗口、工作区切换和文件选择器。WebView2 加载与 Android 版共用的界面、生成算法和上海离线地图。

- 可规划校园周边步行路线、调整跑步参数、导出 GPX 和 FIT。
- Keep 支持短信登录和手动 token。凭证用 Windows 用户范围加密，重启可恢复有效会话，退出登录清除本地副本。
- 在「真实跑步」页导入安卓导出的 JSONL，拟合本地个人配速模型。Windows 使用导入的数据，采集在 Android 上完成。

## 使用

Windows 10 2004（19041）或更新版本，x64。运行 Release 中的 Windows x64 自解压 EXE，然后打开解压目录中的 `SHOU U RUN.exe`。应用自带 .NET 和 Windows App SDK 运行时，界面依赖系统的 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

## 构建

在仓库根目录使用 .NET 8 SDK。

```powershell
dotnet publish .\desktop\ShouURun.Desktop.csproj -c Release -o .\local-build\SHOU-U-RUN-Windows-x64
```
