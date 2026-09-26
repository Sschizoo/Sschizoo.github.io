# 自驾等时圈 H5

部署路径：`/isochrone/`

## 功能

- 桌面端 / 手机端响应式布局
- 输入地点搜索并定位
- 使用浏览器当前位置
- 10–60 分钟自驾等时圈
- 多层时间圈与地图图例
- **无需 API Key，无需注册第三方账号**

## 技术栈

- GitHub Pages（纯静态前端）
- MapLibre GL JS
- OpenFreeMap vector tiles（OpenStreetMap 数据）
- Nominatim（地点搜索；仅在用户主动提交搜索时请求，无自动补全）
- Valhalla 开源路由引擎的 FOSSGIS 公共 Demo 服务（自驾等时圈）

## 算法与服务说明

Valhalla 基于 OpenStreetMap 道路网络执行路由图搜索，并由 isochrone 服务输出指定驾驶时间内的可达区域 GeoJSON。前端直接请求公开服务，因此不需要用户输入密钥。

公共 Demo 服务适合个人、小规模和演示用途，并受 fair-use / rate limit 约束。如果后续访问量较大，应自行部署 Valhalla 服务。

## 使用

1. 访问 https://sschizoo.github.io/isochrone/
2. 输入地点或使用当前位置。
3. 选择驾驶时间。
4. 点击“生成自驾等时圈”。

> Nominatim 与 Valhalla 公共服务均应低频、合理使用。面向大规模正式业务时建议自托管相关开源服务。


## 自由时长与 30 天上限

当前版本支持用户直接输入数值并选择分钟、小时或天，最大 30 天。

- 1–120 分钟：调用 Valhalla 公共服务生成真实道路网络等时圈。
- 超过 120 分钟：由于公共 Valhalla 服务端对单条时间 contour 有硬限制，前端自动切换为“长时程估算”并使用虚线边界明确区分，避免把近似范围误标为精确道路等时圈。
- 如需 2 小时以上仍保持真实道路网络精确计算，需要自托管 Valhalla 并调整 service_limits，同时还要评估超大范围图搜索的计算成本。
