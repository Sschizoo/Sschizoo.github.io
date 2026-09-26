const VALHALLA_ISOCHRONE = 'https://valhalla1.openstreetmap.de/isochrone';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const EXACT_MAX_MINUTES = 120;
const MAX_DURATION_MINUTES = 30 * 24 * 60;

const map = new maplibregl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: [108.5, 34.5],
  zoom: 4,
  minZoom: 1.5,
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
const durationInput = $('durationInput');
const durationUnit = $('durationUnit');
const durationHint = $('durationHint');
const durationModeLabel = $('durationModeLabel');
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
  durationInput.disabled = isBusy;
  durationUnit.disabled = isBusy;
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

function colorForRatio(ratio) {
  if (ratio <= 0.25) return '#0b6f72';
  if (ratio <= 0.50) return '#238b8e';
  if (ratio <= 0.75) return '#58adb0';
  return '#9bd2d8';
}

function unitMultiplier(unit) {
  if (unit === 'day') return 1440;
  if (unit === 'hour') return 60;
  return 1;
}

function formatDuration(minutes) {
  if (minutes % 1440 === 0) return (minutes / 1440) + ' 天';
  if (minutes >= 1440) return (minutes / 1440).toFixed(1).replace(/\.0$/, '') + ' 天';
  if (minutes % 60 === 0) return (minutes / 60) + ' 小时';
  if (minutes >= 60) return (minutes / 60).toFixed(1).replace(/\.0$/, '') + ' 小时';
  return Math.round(minutes) + ' 分钟';
}

function getDurationMinutes() {
  const raw = Number(durationInput.value);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error('请输入大于 0 的驾驶时长。');
  }

  const minutes = raw * unitMultiplier(durationUnit.value);
  if (minutes > MAX_DURATION_MINUTES) {
    throw new Error('最大支持 30 天。');
  }

  return minutes;
}

function syncDurationControl() {
  const unit = durationUnit.value;

  if (unit === 'day') {
    durationInput.max = '30';
    durationInput.step = '0.5';
  } else if (unit === 'hour') {
    durationInput.max = '720';
    durationInput.step = '0.5';
  } else {
    durationInput.max = String(MAX_DURATION_MINUTES);
    durationInput.step = '1';
  }

  let minutes = 0;
  try { minutes = getDurationMinutes(); } catch (_) {}

  const exact = minutes > 0 && minutes <= EXACT_MAX_MINUTES;
  durationModeLabel.textContent = exact ? '精确道路模式' : '长时程估算';
  durationModeLabel.classList.toggle('estimate', !exact);

  if (minutes > MAX_DURATION_MINUTES) {
    durationHint.textContent = '超过上限：最大支持 30 天。';
    durationHint.classList.add('error');
  } else if (exact) {
    durationHint.textContent = '当前使用 Valhalla 真实道路网络等时圈。';
    durationHint.classList.remove('error');
  } else {
    durationHint.textContent = '超过公共 Valhalla 的 120 分钟精确上限，将显示长时程估算范围；边界使用虚线表示。';
    durationHint.classList.remove('error');
  }
}

function buildExactContourMinutes(maxMin) {
  const count = Math.min(4, Math.max(1, Math.ceil(maxMin / 30)));
  const values = [];

  for (let i = 1; i <= count; i++) {
    const v = Math.max(1, Math.round(maxMin * i / count));
    if (!values.includes(v)) values.push(v);
  }

  if (values[values.length - 1] !== Math.round(maxMin)) {
    values[values.length - 1] = Math.round(maxMin);
  }

  return values;
}

function buildEstimateContourMinutes(maxMin) {
  return [0.25, 0.5, 0.75, 1]
    .map(r => Math.max(1, Math.round(maxMin * r)));
}

function renderLegend(minutesList, estimated = false) {
  const max = Math.max(...minutesList);
  legend.innerHTML = minutesList.map(m =>
    '<span class="legend-item">' +
      '<i class="legend-swatch' + (estimated ? ' estimated' : '') +
      '" style="background:' + colorForRatio(m / max) + '"></i>' +
      formatDuration(m) +
    '</span>'
  ).join('') +
  (estimated ? '<span class="legend-mode">虚线＝长时程估算</span>' : '');

  legend.classList.remove('hidden');
}

async function geocode(query) {
  const cached = geocodeCache.get(query);
  if (cached) return cached;

  const url = NOMINATIM +
    '?format=jsonv2&limit=5&accept-language=zh-CN&q=' + encodeURIComponent(query);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  if (!res.ok) {
    throw new Error('地点搜索服务暂时不可用（' + res.status + '）。');
  }

  const data = await res.json();
  geocodeCache.set(query, data);
  return data;
}

async function requestExactIsochrone(maxMinutes) {
  const minutesList = buildExactContourMinutes(maxMinutes);

  const payload = {
    id: 'sschizoo-github-pages-isochrone',
    locations: [{ lat: origin.lat, lon: origin.lon }],
    costing: 'auto',
    contours: minutesList.map((m, idx) => ({
      time: m,
      color: colorForRatio((idx + 1) / minutesList.length).replace('#', '')
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

async function drawExactIsochrones(body, minutesList) {
  await waitForMapLoad();
  clearIsochroneLayers();

  const sortedFeatures = [...body.features].sort(
    (a, b) => Number(b.properties?.contour || 0) -
              Number(a.properties?.contour || 0)
  );

  map.addSource('isochrones', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: sortedFeatures
    }
  });

  const beforeId = findFirstSymbolLayer();
  const max = Math.max(...minutesList);
  const descending = [...minutesList].sort((a, b) => b - a);

  for (const minutes of descending) {
    const fillId = 'iso-fill-' + minutes;
    const lineId = 'iso-line-' + minutes;
    const filter = ['==', ['to-number', ['get', 'contour']], minutes];
    const color = colorForRatio(minutes / max);

    map.addLayer({
      id: fillId,
      type: 'fill',
      source: 'isochrones',
      filter,
      paint: {
        'fill-color': color,
        'fill-opacity': 0.17
      }
    }, beforeId);

    map.addLayer({
      id: lineId,
      type: 'line',
      source: 'isochrones',
      filter,
      paint: {
        'line-color': color,
        'line-width': 1.5,
        'line-opacity': 0.92
      }
    }, beforeId);

    contourLayerIds.push(fillId, lineId);
  }

  fitGeoJSON(sortedFeatures);
}

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const R = 6371.0088;
  const delta = Math.min(distanceKm, 19900) / R;
  const theta = bearingDeg * Math.PI / 180;
  const phi1 = lat * Math.PI / 180;
  const lambda1 = lon * Math.PI / 180;

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) +
    Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);

  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));

  const y =
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);

  const x =
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2);

  let lambda2 = lambda1 + Math.atan2(y, x);
  lambda2 = ((lambda2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

  return [
    lambda2 * 180 / Math.PI,
    phi2 * 180 / Math.PI
  ];
}

function effectiveSpeedKmh(minutes) {
  const hours = minutes / 60;
  if (hours <= 6) return 62;
  if (hours <= 24) return 58;
  if (hours <= 72) return 54;
  if (hours <= 168) return 50;
  return 46;
}

function makeEstimateFeature(minutes, maxMinutes) {
  const hours = minutes / 60;
  const radiusKm = Math.min(
    hours * effectiveSpeedKmh(minutes),
    19900
  );

  const coordinates = [];
  const steps = 180;

  for (let i = 0; i <= steps; i++) {
    const bearing = i * 360 / steps;
    coordinates.push(
      destinationPoint(
        origin.lat,
        origin.lon,
        bearing,
        radiusKm
      )
    );
  }

  return {
    type: 'Feature',
    properties: {
      contour: minutes,
      estimated: true,
      ratio: minutes / maxMinutes
    },
    geometry: {
      type: 'Polygon',
      coordinates: [coordinates]
    }
  };
}

async function drawEstimatedIsochrones(maxMinutes) {
  await waitForMapLoad();
  clearIsochroneLayers();

  const minutesList = buildEstimateContourMinutes(maxMinutes);
  const features = minutesList.map(m => makeEstimateFeature(m, maxMinutes));

  map.addSource('isochrones', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features
    }
  });

  const beforeId = findFirstSymbolLayer();
  const descending = [...minutesList].sort((a, b) => b - a);

  for (const minutes of descending) {
    const fillId = 'iso-fill-est-' + minutes;
    const lineId = 'iso-line-est-' + minutes;
    const filter = ['==', ['to-number', ['get', 'contour']], minutes];
    const color = colorForRatio(minutes / maxMinutes);

    map.addLayer({
      id: fillId,
      type: 'fill',
      source: 'isochrones',
      filter,
      paint: {
        'fill-color': color,
        'fill-opacity': 0.095
      }
    }, beforeId);

    map.addLayer({
      id: lineId,
      type: 'line',
      source: 'isochrones',
      filter,
      paint: {
        'line-color': color,
        'line-width': 1.6,
        'line-opacity': 0.82,
        'line-dasharray': [3, 2]
      }
    }, beforeId);

    contourLayerIds.push(fillId, lineId);
  }

  fitGeoJSON(features);
  renderLegend(minutesList, true);
}

function fitGeoJSON(features) {
  const bounds = new maplibregl.LngLatBounds();

  for (const feature of features) {
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
    setStatus('地点已定位。输入驾驶时长后即可生成。');
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
      setStatus('已获取当前位置，可输入任意驾驶时长。');
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

durationInput.addEventListener('input', syncDurationControl);
durationUnit.addEventListener('change', () => {
  const value = Number(durationInput.value);

  if (durationUnit.value === 'day' && value > 30) durationInput.value = '30';
  if (durationUnit.value === 'hour' && value > 720) durationInput.value = '720';

  syncDurationControl();
});

generateBtn.addEventListener('click', async () => {
  if (!origin) return;

  let maxMinutes;
  try {
    maxMinutes = getDurationMinutes();
  } catch (err) {
    setStatus(err.message, true);
    return;
  }

  setBusy(true);

  try {
    if (maxMinutes <= EXACT_MAX_MINUTES) {
      setStatus('正在基于真实道路网络计算自驾可达范围…');

      const { body, minutesList } =
        await requestExactIsochrone(maxMinutes);

      await drawExactIsochrones(body, minutesList);
      renderLegend(minutesList, false);

      setStatus(
        '已生成 ' + formatDuration(maxMinutes) +
        ' 的真实道路网络等时圈。'
      );
    } else {
      setStatus(
        '该时长超过公共 Valhalla 的 120 分钟精确计算上限，正在生成长时程估算范围…'
      );

      await drawEstimatedIsochrones(maxMinutes);

      setStatus(
        '已生成 ' + formatDuration(maxMinutes) +
        ' 的长时程估算范围。虚线边界为估算结果，不代表精确道路可达性。'
      );
    }
  } catch (err) {
    setStatus(
      err.message || '等时圈生成失败，请稍后重试。',
      true
    );
  } finally {
    setBusy(false);
    syncDurationControl();
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

syncDurationControl();
