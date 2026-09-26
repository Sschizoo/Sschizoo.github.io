const VALHALLA_ISOCHRONE = 'https://valhalla1.openstreetmap.de/isochrone';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const map = new maplibregl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: [108.5, 34.5],
  zoom: 4,
  minZoom: 2,
  maxZoom: 18,
  attributionControl: false
});

map.addControl(new maplibregl.NavigationControl({
  showCompass: false,
  visualizePitch: false
}), 'top-right');

map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: '© OpenFreeMap · © OpenStreetMap contributors'
}), 'bottom-right');

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
let contourLayerIds = [];
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

function waitForMapLoad() {
  if (map.loaded()) return Promise.resolve();
  return new Promise(resolve => map.once('load', resolve));
}

function setOrigin(lat, lon, label) {
  origin = { lat: Number(lat), lon: Number(lon), label };

  if (originMarker) originMarker.remove();

  const markerEl = document.createElement('div');
  markerEl.className = 'origin-marker';
  markerEl.innerHTML = '<span></span>';

  originMarker = new maplibregl.Marker({
    element: markerEl,
    anchor: 'center'
  })
    .setLngLat([origin.lon, origin.lat])
    .setPopup(
      new maplibregl.Popup({ offset: 16, closeButton: false })
        .setHTML('<strong>起点</strong><br>' + escapeHtml(label))
    )
    .addTo(map);

  placeName.textContent = label;
  placeCard.classList.remove('hidden');
  recenterBtn.classList.remove('hidden');
  generateBtn.disabled = false;

  map.easeTo({
    center: [origin.lon, origin.lat],
    zoom: Math.max(map.getZoom(), 11.5),
    duration: 750
  });
}

function colorFor(minutes) {
  if (minutes <= 10) return '#0b6f72';
  if (minutes <= 20) return '#117f83';
  if (minutes <= 30) return '#1d9397';
  if (minutes <= 40) return '#43a8aa';
  if (minutes <= 50) return '#73c0c3';
  return '#a9d9df';
}

function buildContourMinutes(maxMin) {
  // FOSSGIS 的公开 Valhalla 实例一次最多允许 4 条 contour。
  // 10–40 分钟保持 10 分钟间隔；50/60 分钟压缩为 4 条并保留最大值。
  if (maxMin <= 40) {
    const values = [];
    for (let m = 10; m <= maxMin; m += 10) values.push(m);
    return values;
  }
  if (maxMin === 50) return [10, 20, 35, 50];
  return [15, 30, 45, 60];
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

  if (!res.ok) {
    throw new Error('地点搜索服务暂时不可用（' + res.status + '）。');
  }

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
    denoise: 0.2,
    generalize: 45
  };

  const url = VALHALLA_ISOCHRONE +
    '?json=' + encodeURIComponent(JSON.stringify(payload));

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

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

function clearIsochroneLayers() {
  for (const id of contourLayerIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  contourLayerIds = [];

  if (map.getSource('isochrones')) {
    map.removeSource('isochrones');
  }
}

function findFirstSymbolLayer() {
  const layers = map.getStyle()?.layers || [];
  return layers.find(layer => layer.type === 'symbol')?.id;
}

function extendBoundsFromCoordinates(coords, bounds) {
  if (!Array.isArray(coords)) return;

  if (
    coords.length >= 2 &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number'
  ) {
    bounds.extend([coords[0], coords[1]]);
    return;
  }

  for (const item of coords) {
    extendBoundsFromCoordinates(item, bounds);
  }
}

async function drawIsochrones(body, minutesList) {
  await waitForMapLoad();
  clearIsochroneLayers();

  const sortedFeatures = [...body.features].sort(
    (a, b) => Number(b.properties?.contour || 0) -
              Number(a.properties?.contour || 0)
  );

  const geojson = {
    type: 'FeatureCollection',
    features: sortedFeatures
  };

  map.addSource('isochrones', {
    type: 'geojson',
    data: geojson
  });

  const beforeId = findFirstSymbolLayer();
  const descending = [...minutesList].sort((a, b) => b - a);

  for (const minutes of descending) {
    const fillId = 'iso-fill-' + minutes;
    const lineId = 'iso-line-' + minutes;
    const filter = ['==', ['to-number', ['get', 'contour']], minutes];

    map.addLayer({
      id: fillId,
      type: 'fill',
      source: 'isochrones',
      filter,
      paint: {
        'fill-color': colorFor(minutes),
        'fill-opacity': minutes <= 20 ? 0.19 : 0.16
      }
    }, beforeId);

    map.addLayer({
      id: lineId,
      type: 'line',
      source: 'isochrones',
      filter,
      paint: {
        'line-color': colorFor(minutes),
        'line-width': minutes <= 20 ? 1.9 : 1.25,
        'line-opacity': 0.92
      }
    }, beforeId);

    contourLayerIds.push(fillId, lineId);
  }

  const bounds = new maplibregl.LngLatBounds();
  for (const feature of sortedFeatures) {
    extendBoundsFromCoordinates(feature.geometry?.coordinates, bounds);
  }

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, {
      padding: {
        top: 70,
        right: 70,
        bottom: 70,
        left: window.innerWidth <= 760 ? 70 : 430
      },
      duration: 850,
      maxZoom: 11
    });
  }
}

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const q = placeInput.value.trim();
  if (!q) return;

  setBusy(true);
  setStatus('正在查找地点…');

  try {
    const data = await geocode(q);

    if (!data.length) {
      throw new Error('没有找到这个地点，请尝试更具体的名称。');
    }

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
      setOrigin(
        pos.coords.latitude,
        pos.coords.longitude,
        '设备当前位置'
      );
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
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    }
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

    await drawIsochrones(body, minutesList);
    renderLegend(minutesList);

    setStatus('已生成道路网络自驾等时圈。底图与算法均无需 API Key。');
  } catch (err) {
    setStatus(
      err.message || '等时圈生成失败，请稍后重试。',
      true
    );
  } finally {
    setBusy(false);
  }
});

recenterBtn.addEventListener('click', () => {
  if (!origin) return;

  map.easeTo({
    center: [origin.lon, origin.lat],
    zoom: 11.5,
    duration: 650
  });
});

map.on('error', (e) => {
  const msg = String(e?.error?.message || '');
  if (msg && /401|403|api key|token/i.test(msg)) {
    setStatus('底图服务响应异常，请刷新页面重试。', true);
  }
});
