const VALHALLA_ISOCHRONE = 'https://valhalla1.openstreetmap.de/isochrone';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const map = L.map('map', { zoomControl: true }).setView([34.5, 108.5], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const $ = (id) => document.getElementById(id);
const searchForm = $('searchForm');
const placeInput = $('placeInput');
const locateBtn = $('locateBtn');
const generateBtn = $('generateBtn');
const timeRange = $('timeRange');
const timeLabel = $('timeLabel');
const placeCard = $('placeCard');
const placeName = $('placeName');
const statusEl = $('status');
const legend = $('legend');
const recenterBtn = $('recenterBtn');

let origin = null;
let originMarker = null;
let isoLayer = null;
const geocodeCache = new Map();

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function setBusy(isBusy) {
  generateBtn.disabled = isBusy || !origin;
  searchForm.querySelector('button').disabled = isBusy;
  locateBtn.disabled = isBusy;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function setOrigin(lat, lon, label) {
  origin = { lat: Number(lat), lon: Number(lon), label };
  if (originMarker) originMarker.remove();
  originMarker = L.marker([origin.lat, origin.lon]).addTo(map)
    .bindPopup('<strong>起点</strong><br>' + escapeHtml(label));
  placeName.textContent = label;
  placeCard.classList.remove('hidden');
  recenterBtn.classList.remove('hidden');
  generateBtn.disabled = false;
  map.flyTo([origin.lat, origin.lon], Math.max(map.getZoom(), 12), { duration: .7 });
}

function colorFor(minutes) {
  if (minutes <= 10) return '#2f80ed';
  if (minutes <= 20) return '#27ae60';
  if (minutes <= 30) return '#f2c94c';
  if (minutes <= 40) return '#f2994a';
  if (minutes <= 50) return '#eb5757';
  return '#9b51e0';
}

function buildContourMinutes(maxMin) {
  if (maxMin <= 50) {
    const values = [];
    for (let m = 10; m <= maxMin; m += 10) values.push(m);
    return values;
  }
  // Valhalla 公共服务通常限制等时圈 contour 数量。
  return [10, 20, 30, 45, 60];
}

function renderLegend(minutesList) {
  legend.innerHTML = minutesList.map(m =>
    '<span class="legend-item"><i class="legend-swatch" style="background:' +
    colorFor(m) + '"></i>' + m + ' 分钟</span>'
  ).join('');
  legend.classList.remove('hidden');
}

async function geocode(query) {
  const cached = geocodeCache.get(query);
  if (cached) return cached;

  const url = NOMINATIM +
    '?format=jsonv2&limit=5&accept-language=zh-CN&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('地点搜索服务暂时不可用（' + res.status + '）。');

  const data = await res.json();
  geocodeCache.set(query, data);
  return data;
}

async function requestIsochrone() {
  const minutesList = buildContourMinutes(Number(timeRange.value));
  const payload = {
    id: 'sschizoo-github-pages-isochrone',
    locations: [{ lat: origin.lat, lon: origin.lon }],
    costing: 'auto',
    contours: minutesList.map(m => ({
      time: m,
      color: colorFor(m).replace('#', '')
    })),
    polygons: true,
    denoise: 0.25,
    generalize: 60
  };

  // GET + json 参数是 Valhalla 官方支持的调用方式之一，
  // 这样 GitHub Pages 可以直接调用，不需要 API Key 或后端代理。
  const url = VALHALLA_ISOCHRONE + '?json=' + encodeURIComponent(JSON.stringify(payload));
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });

  let body = null;
  try { body = await res.json(); } catch (_) {}

  if (!res.ok) {
    if (res.status === 429) {
      throw new Error('免费公共路由服务当前请求较多，请稍后再试。');
    }
    const detail = body?.error || body?.status || ('HTTP ' + res.status);
    throw new Error('等时圈生成失败：' + detail);
  }

  if (!body?.features?.length) {
    throw new Error('该位置附近没有获得可用的道路网络等时圈。');
  }
  return { body, minutesList };
}

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = placeInput.value.trim();
  if (!q) return;

  setBusy(true);
  setStatus('正在查找地点…');

  try {
    const data = await geocode(q);
    if (!data.length) throw new Error('没有找到这个地点，请尝试更具体的名称。');

    const best = data[0];
    setOrigin(best.lat, best.lon, best.display_name || q);
    setStatus('地点已定位。选择时间后即可生成等时圈。');
  } catch (err) {
    setStatus(err.message || '地点查找失败。', true);
  } finally {
    setBusy(false);
  }
});

locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus('当前浏览器不支持定位。', true);
    return;
  }

  setStatus('正在获取设备位置…');
  locateBtn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    pos => {
      setOrigin(pos.coords.latitude, pos.coords.longitude, '设备当前位置');
      setStatus('已获取当前位置，可直接生成等时圈。');
      locateBtn.disabled = false;
    },
    err => {
      const msg = err.code === 1
        ? '定位权限被拒绝，请在浏览器设置中允许定位。'
        : '无法获取当前位置，请改为输入地点。';
      setStatus(msg, true);
      locateBtn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
});

timeRange.addEventListener('input', () => {
  timeLabel.textContent = timeRange.value + ' 分钟';
});

generateBtn.addEventListener('click', async () => {
  if (!origin) return;

  setBusy(true);
  setStatus('正在基于道路网络计算自驾可达范围…');

  try {
    const { body, minutesList } = await requestIsochrone();

    if (isoLayer) isoLayer.remove();

    const sorted = [...body.features].sort((a, b) =>
      Number(b.properties?.contour || 0) - Number(a.properties?.contour || 0)
    );

    isoLayer = L.geoJSON(
      { type: 'FeatureCollection', features: sorted },
      {
        style: feature => {
          const minutes = Number(feature.properties?.contour || 0);
          const color = colorFor(minutes);
          return {
            color,
            weight: 2,
            fillColor: color,
            fillOpacity: .16,
            opacity: .9
          };
        },
        onEachFeature: (feature, layer) => {
          const minutes = Number(feature.properties?.contour || 0);
          layer.bindTooltip(minutes + ' 分钟可达范围');
        }
      }
    ).addTo(map);

    const bounds = isoLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [26, 26] });

    renderLegend(minutesList);
    setStatus('已生成道路网络自驾等时圈。无需 API Key。');
  } catch (err) {
    setStatus(err.message || '等时圈生成失败，请稍后重试。', true);
  } finally {
    setBusy(false);
  }
});

recenterBtn.addEventListener('click', () => {
  if (origin) map.flyTo([origin.lat, origin.lon], 12, { duration: .6 });
});

window.addEventListener('resize', () => {
  setTimeout(() => map.invalidateSize(), 120);
});
