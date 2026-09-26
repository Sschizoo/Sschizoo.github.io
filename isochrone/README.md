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
- Leaflet
- OpenStreetMap tiles
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
