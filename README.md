# SHOU U RUN

[English README](README.en.md)

一款 Android 跑步路线与数据实验应用。可在地图上选点、按已标注步行道路规划校园周边路线、调整运动参数并导出模拟 GPX/FIT；也可使用手机 GPS 采集自己的原始跑步记录，导出 JSONL 供后续分析。

**当前版本：1.0.0。** 模拟数据与真实 GPS 记录在界面和文件中分开标注。可用自己当前有效的 Keep 登录凭证上传模拟记录；凭证仅在本次请求中使用，不会写入 APK、文件或应用存储。数据生成算法仍在打磨中。

## 功能

- 上海离线矢量地图；可切换 OpenStreetMap 在线地图或 Esri 卫星影像。
- 在上海海洋大学周边，将选点吸附到本地步行路网，规划已标注的人行道、步行街和过街通道。其他地区目前只支持浏览底图。
- 以配速和随机波动生成模拟活动，导出 GPX 或 FIT。提供蓝鲸世界至上海海洋大学 1 号门示例。
- 可将当前模拟活动直接提交到自己的 Keep 账号。此功能使用非官方接口，上传结果和记录来源需在 Keep 中核对。
- 用 Android 前台服务采集真实 GPS 定位，记录时间、位置、精度、速度及暂停事件，导出原始 JSONL。尚未采集心率或步频，也没有自动训练模型。

## 构建

Android 8.0+。可用 Android Studio 打开本目录，用 JDK 17、Android SDK 35 和 Gradle 8.9 构建 `app`。项目使用 Android Gradle Plugin 8.7.3，未附带 Gradle wrapper。

也可用 PowerShell 调用 `build-local.ps1`，传入 JDK 17、SDK Build Tools 和 `android.jar` 的路径。脚本在 `local-build/` 生成调试签名 APK。调试密钥会在本机生成，绝不要用于正式发布。

```powershell
.\build-local.ps1 -Jdk 'C:\path\to\jdk-17' -BuildTools 'C:\path\to\android-sdk\build-tools\35.0.0' -AndroidJar 'C:\path\to\android-sdk\platforms\android-35\android.jar'
```

## 目录

- `app/src/main/java/`：Android 容器、文件导出、真实 GPS 记录服务。
- `app/src/main/java/com/runlab/app/KeepUploader.java`：Keep 提交请求的生成与发送。
- `app/src/main/assets/core.js`：模拟记录及 GPX/FIT 生成。
- `app/src/main/assets/app.js`：路线与参数界面。
- `app/src/main/assets/shanghai/`：上海离线地图派生数据。
- `tools/`：从 OpenStreetMap 提取数据生成离线地图的脚本。
- `REAL-DATA.md`：原始 GPS 数据格式与限制。

## 限制

- 路网来自 OpenStreetMap 标注，不保证道路现场开放；严格步行路由目前只覆盖校园周边。
- 在线地图是否可用取决于网络和图源服务。
- Keep 上传使用非官方接口；Keep 更新后可能失效。不要将登录凭证提交到 GitHub 或分享给他人。
- 模拟 GPX/FIT 仅用于开发和数据研究，不能证明实际运动。
- 真实记录依赖手机 GPS 和系统后台策略；锁屏连续采集仍需在具体机型上验证。
- 本仓库没有用户真实跑步数据、Keep 账号数据、APK 或签名密钥。角色插画图标由项目所有者提供，不在项目 MIT 许可证的授权范围内。

## 许可与来源

本项目自有代码以 MIT 许可证发布，见 [LICENSE](LICENSE)。部分计算与导出设计参考 [keep-data-sim](https://github.com/StringsLi/keep-data-sim)，保留其 [MIT 许可](LICENSE-upstream.txt)。地图界面使用 [Leaflet](https://leafletjs.com/)，保留其 [BSD 2-Clause 许可](LICENSE-Leaflet.txt)。上海离线地图及校园路网基于 [OpenStreetMap](https://www.openstreetmap.org/copyright) 数据，按 ODbL 1.0 使用；细节见 [DATA-LICENSE.md](DATA-LICENSE.md)。
