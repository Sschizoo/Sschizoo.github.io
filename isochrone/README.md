# 自驾等时圈 H5

部署路径：`/isochrone/`

## 功能

- 桌面端 / 手机端响应式布局
- 输入地点搜索并定位
- 使用浏览器当前位置
- 10–60 分钟自驾等时圈
- 多层时间圈与地图图例
- API Key 仅保存在浏览器 localStorage，不写入仓库

## 技术栈

- GitHub Pages（纯静态前端）
- Leaflet
- OpenStreetMap tiles
- Nominatim（地点搜索；仅在用户主动提交搜索时请求，无自动补全）
- openrouteservice Isochrones API

## 使用

1. 访问 https://sschizoo.github.io/isochrone/
2. 点右上角设置按钮。
3. 填入 openrouteservice API Key。
4. 输入地点或使用当前位置。
5. 选择驾驶时间并生成等时圈。

> 公共 Nominatim 服务有使用限制，请勿用于高频或批量地理编码。若后续面向大量用户，建议换成自托管或商业地理编码服务。
