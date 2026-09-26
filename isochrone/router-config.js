// 路由引擎配置（不包含任何 API Key）
//
// graphhopperBaseUrl:
//   部署自建 GraphHopper 后填入公网 HTTPS 地址，例如：
//   https://routing.example.com
//   留空时，1–120 分钟继续使用 FOSSGIS 公共 Valhalla；
//   >120 分钟会明确提示需要自建精确引擎，不会生成近似结果。
window.ISOCHRONE_CONFIG = {
  graphhopperBaseUrl: '',
  publicValhallaBaseUrl: 'https://valhalla1.openstreetmap.de'
};
