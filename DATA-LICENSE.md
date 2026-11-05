# 地图数据许可

`app/src/main/assets/shanghai/` 和 `app/src/main/assets/offline-data.js` 包含基于 OpenStreetMap 的派生地图数据。数据贡献者为 © OpenStreetMap contributors，按 Open Database License (ODbL) 1.0 提供：

- https://www.openstreetmap.org/copyright
- https://opendatacommons.org/licenses/odbl/1-0/

上海区域提取来自 Geofabrik：https://download.geofabrik.de/asia/china/shanghai.html 。`app/src/main/assets/shanghai/manifest.json` 记录了来源和原始 PBF 的 SHA-256。地图处理脚本见 `tools/`。

本仓库的 MIT 许可证不覆盖这些地图数据；使用或再分发派生数据时应遵守 ODbL 1.0，并保留来源与贡献者署名。
