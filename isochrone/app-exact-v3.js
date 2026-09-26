const CONFIG = window.ISOCHRONE_CONFIG || {};
const PUBLIC_VALHALLA_BASE =
  (CONFIG.publicValhallaBaseUrl || 'https://valhalla1.openstreetmap.de').replace(/\/$/, '');
const GRAPHHOPPER_BASE =
  (CONFIG.graphhopperBaseUrl || '').replace(/\/$/, '');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const PUBLIC_VALHALLA_MAX_MINUTES = 120;
const MAX_DURATION_MINUTES = 30 * 24 * 60;
const BUCKET_COUNT = 4;

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
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function waitForMapLoad() {
  if (map.loaded()) return Promise.resolve();
  return new Promise(resolve => map.once('load', resolve));
}

function setOrigin(lat, lon, label) {
  origin = {
    lat: Number(lat),
    lon: Number(lon),
    label
  };

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
      new maplibregl.Popup({
        offset: 16,
        closeButton: false
      }).setHTML(
        '<strong>起点</strong><br>' + escapeHtml(label)
      )
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

function unitMultiplier(unit) {
  if (unit === 'day') return 1440;
  if (unit === 'hour') return 60;
  return 1;
}

function formatDuration(minutes) {
  if (minutes % 1440 === 0) {
    return (minutes / 1440) + ' 天';
  }
  if (minutes >= 1440) {
    return (minutes / 1440)
      .toFixed(1)
      .replace(/\.0$/, '') + ' 天';
  }
  if (minutes % 60 === 0) {
    return (minutes / 60) + ' 小时';
  }
  if (minutes >= 60) {
    return (minutes / 60)
      .toFixed(1)
      .replace(/\.0$/, '') + ' 小时';
  }
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

function chooseEngine(minutes) {
  if (GRAPHHOPPER_BASE) return 'graphhopper';
  if (minutes <= PUBLIC_VALHALLA_MAX_MINUTES) return 'valhalla-public';
  return 'unavailable';
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
  try {
    minutes = getDurationMinutes();
  } catch (_) {}

  if (!minutes) {
    durationModeLabel.textContent = '真实道路网络';
    durationHint.textContent = '请输入驾驶时长。';
    return;
  }

  const engine = chooseEngine(minutes);

  if (engine === 'graphhopper') {
    durationModeLabel.textContent = '真实道路 · GraphHopper';
    durationModeLabel.classList.remove('estimate');
    durationHint.textContent =
      '使用自建 GraphHopper 最短路径树计算真实道路可达范围。';
  } else if (engine === 'valhalla-public') {
    durationModeLabel.textContent = '真实道路 · Valhalla';
    durationModeLabel.classList.remove('estimate');
    durationHint.textContent =
      '当前使用 FOSSGIS 公共 Valhalla，精确时长上限 120 分钟。';
  } else {
    durationModeLabel.textContent = '需要扩展精确引擎';
    durationModeLabel.classList.add('estimate');
    durationHint.textContent =
      '该时长超过公共 Valhalla 的 120 分钟限制。为了保证结果仍是真实道路网络等时圈，本页面不会生成估算圆；请接入自建 GraphHopper。';
  }
}

function colorForRatio(ratio) {
  if (ratio <= 0.25) return '#0b6f72';
  if (ratio <= 0.50) return '#238b8e';
  if (ratio <= 0.75) return '#58adb0';
  return '#9bd2d8';
}

function buildValhallaContours(maxMinutes) {
  const count = Math.min(
    4,
    Math.max(1, Math.ceil(maxMinutes / 30))
  );

  const values = [];

  for (let i = 1; i <= count; i++) {
    const value = Math.max(
      1,
      Math.round(maxMinutes * i / count)
    );
    if (!values.includes(value)) values.push(value);
  }

  values[values.length - 1] = Math.round(maxMinutes);
  return values;
}

function renderLegend(minutesList) {
  const max = Math.max(...minutesList);

  legend.innerHTML = minutesList.map(minutes => (
    '<span class="legend-item">' +
      '<i class="legend-swatch" style="background:' +
      colorForRatio(minutes / max) +
      '"></i>' +
      formatDuration(minutes) +
    '</span>'
  )).join('');

  legend.classList.remove('hidden');
}

async function geocode(query) {
  const cached = geocodeCache.get(query);
  if (cached) return cached;

  const url =
    NOMINATIM +
    '?format=jsonv2&limit=5&accept-language=zh-CN&q=' +
    encodeURIComponent(query);

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(
      '地点搜索服务暂时不可用（' +
      response.status +
      '）。'
    );
  }

  const data = await response.json();
  geocodeCache.set(query, data);
  return data;
}

async function requestValhallaIsochrone(maxMinutes) {
  const minutesList = buildValhallaContours(maxMinutes);

  const payload = {
    id: 'sschizoo-github-pages-isochrone',
    locations: [{
      lat: origin.lat,
      lon: origin.lon
    }],
    costing: 'auto',
    contours: minutesList.map((minutes, index) => ({
      time: minutes,
      color: colorForRatio(
        (index + 1) / minutesList.length
      ).replace('#', '')
    })),
    polygons: true,
    denoise: 0.2,
    generalize: 45
  };

  const url =
    PUBLIC_VALHALLA_BASE +
    '/isochrone?json=' +
    encodeURIComponent(JSON.stringify(payload));

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json'
    }
  });

  let body = null;
  try {
    body = await response.json();
  } catch (_) {}

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        '公共 Valhalla 当前请求较多，请稍后再试。'
      );
    }

    const detail =
      body?.error ||
      body?.status ||
      ('HTTP ' + response.status);

    throw new Error(
      '真实道路等时圈生成失败：' + detail
    );
  }

  if (!body?.features?.length) {
    throw new Error(
      '该位置附近没有获得可用的道路网络等时圈。'
    );
  }

  return {
    body,
    minutesList
  };
}

async function requestGraphHopperIsochrone(maxMinutes) {
  const timeLimitSeconds =
    Math.round(maxMinutes * 60);

  const params = new URLSearchParams({
    point: origin.lat + ',' + origin.lon,
    profile: 'car',
    time_limit: String(timeLimitSeconds),
    buckets: String(BUCKET_COUNT),
    reverse_flow: 'false',
    type: 'geojson',
    full_geometry: 'true'
  });

  const response = await fetch(
    GRAPHHOPPER_BASE +
    '/isochrone?' +
    params.toString(),
    {
      headers: {
        'Accept': 'application/json'
      }
    }
  );

  let body = null;
  try {
    body = await response.json();
  } catch (_) {}

  if (!response.ok) {
    const detail =
      body?.message ||
      body?.hints?.[0]?.message ||
      ('HTTP ' + response.status);

    throw new Error(
      'GraphHopper 真实道路等时圈生成失败：' +
      detail
    );
  }

  if (!body?.features?.length) {
    throw new Error(
      'GraphHopper 没有返回可用等时圈。'
    );
  }

  const minutesList = [];

  body.features.forEach((feature, index) => {
    const bucket = Number(
      feature.properties?.bucket ?? index
    );

    const minutes =
      maxMinutes *
      (bucket + 1) /
      BUCKET_COUNT;

    feature.properties = {
      ...(feature.properties || {}),
      contour: minutes
    };

    minutesList.push(minutes);
  });

  minutesList.sort((a, b) => a - b);

  return {
    body,
    minutesList
  };
}

function clearIsochroneLayers() {
  for (const id of contourLayerIds) {
    if (map.getLayer(id)) {
      map.removeLayer(id);
    }
  }

  contourLayerIds = [];

  if (map.getSource('isochrones')) {
    map.removeSource('isochrones');
  }
}

function findFirstSymbolLayer() {
  const layers = map.getStyle()?.layers || [];
  return layers.find(
    layer => layer.type === 'symbol'
  )?.id;
}

function extendBoundsFromCoordinates(coords, bounds) {
  if (!Array.isArray(coords)) return;

  if (
    coords.length >= 2 &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number'
  ) {
    bounds.extend([
      coords[0],
      coords[1]
    ]);
    return;
  }

  for (const item of coords) {
    extendBoundsFromCoordinates(
      item,
      bounds
    );
  }
}

function fitGeoJSON(features) {
  const bounds =
    new maplibregl.LngLatBounds();

  for (const feature of features) {
    extendBoundsFromCoordinates(
      feature.geometry?.coordinates,
      bounds
    );
  }

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, {
      padding: {
        top: 70,
        right: 70,
        bottom: 70,
        left:
          window.innerWidth <= 760
            ? 70
            : 430
      },
      duration: 850,
      maxZoom: 11
    });
  }
}

async function drawIsochrones(body, minutesList) {
  await waitForMapLoad();
  clearIsochroneLayers();

  const features = [...body.features];

  // Valhalla 的 contour 已经带分钟数；
  // GraphHopper 在 requestGraphHopperIsochrone 中补入 contour。
  features.forEach(feature => {
    if (
      feature.properties &&
      feature.properties.contour == null &&
      feature.properties.time != null
    ) {
      feature.properties.contour =
        Number(feature.properties.time);
    }
  });

  const sortedFeatures =
    features.sort(
      (a, b) =>
        Number(b.properties?.contour || 0) -
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

  const descending =
    [...minutesList].sort((a, b) => b - a);

  descending.forEach((minutes, index) => {
    const fillId = 'iso-fill-' + index;
    const lineId = 'iso-line-' + index;

    const tolerance = Math.max(
      0.02,
      max * 0.000001
    );

    const filter = [
      'all',
      ['has', 'contour'],
      [
        '<=',
        [
          'abs',
          [
            '-',
            ['to-number', ['get', 'contour']],
            minutes
          ]
        ],
        tolerance
      ]
    ];

    const color =
      colorForRatio(minutes / max);

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

    contourLayerIds.push(
      fillId,
      lineId
    );
  });

  fitGeoJSON(sortedFeatures);
}

searchForm.addEventListener(
  'submit',
  async event => {
    event.preventDefault();

    const query =
      placeInput.value.trim();

    if (!query) return;

    setBusy(true);
    setStatus('正在查找地点…');

    try {
      const data =
        await geocode(query);

      if (!data.length) {
        throw new Error(
          '没有找到这个地点，请尝试更具体的名称。'
        );
      }

      const best = data[0];

      setOrigin(
        best.lat,
        best.lon,
        best.display_name || query
      );

      setStatus(
        '地点已定位。输入驾驶时长后即可生成真实道路等时圈。'
      );
    } catch (error) {
      setStatus(
        error.message ||
        '地点查找失败。',
        true
      );
    } finally {
      setBusy(false);
    }
  }
);

locateBtn.addEventListener(
  'click',
  () => {
    if (!navigator.geolocation) {
      setStatus(
        '当前浏览器不支持定位。',
        true
      );
      return;
    }

    setStatus(
      '正在获取设备位置…'
    );

    locateBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      position => {
        setOrigin(
          position.coords.latitude,
          position.coords.longitude,
          '设备当前位置'
        );

        setStatus(
          '已获取当前位置。'
        );

        locateBtn.disabled = false;
      },
      error => {
        const message =
          error.code === 1
            ? '定位权限被拒绝，请在浏览器设置中允许定位。'
            : '无法获取当前位置，请改为输入地点。';

        setStatus(
          message,
          true
        );

        locateBtn.disabled = false;
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000
      }
    );
  }
);

durationInput.addEventListener(
  'input',
  syncDurationControl
);

durationUnit.addEventListener(
  'change',
  () => {
    const value =
      Number(durationInput.value);

    if (
      durationUnit.value === 'day' &&
      value > 30
    ) {
      durationInput.value = '30';
    }

    if (
      durationUnit.value === 'hour' &&
      value > 720
    ) {
      durationInput.value = '720';
    }

    syncDurationControl();
  }
);

generateBtn.addEventListener(
  'click',
  async () => {
    if (!origin) {
      setStatus(
        '请先选择起点。',
        true
      );
      return;
    }

    let maxMinutes;

    try {
      maxMinutes =
        getDurationMinutes();
    } catch (error) {
      setStatus(
        error.message,
        true
      );
      return;
    }

    const engine =
      chooseEngine(maxMinutes);

    if (engine === 'unavailable') {
      setStatus(
        '该时长需要自建 GraphHopper 才能保持真实道路网络计算。当前公共 Valhalla 的精确等时圈上限为 120 分钟；本页面已禁止使用估算圆。',
        true
      );
      return;
    }

    setBusy(true);

    try {
      setStatus(
        '正在沿真实道路网络计算 ' +
        formatDuration(maxMinutes) +
        ' 可达范围…'
      );

      const result =
        engine === 'graphhopper'
          ? await requestGraphHopperIsochrone(maxMinutes)
          : await requestValhallaIsochrone(maxMinutes);

      await drawIsochrones(
        result.body,
        result.minutesList
      );

      renderLegend(
        result.minutesList
      );

      setStatus(
        '已生成 ' +
        formatDuration(maxMinutes) +
        ' 的真实道路网络等时圈。'
      );
    } catch (error) {
      console.error(error);

      setStatus(
        error.message ||
        '等时圈生成失败，请稍后重试。',
        true
      );
    } finally {
      setBusy(false);
      syncDurationControl();
    }
  }
);

recenterBtn.addEventListener(
  'click',
  () => {
    if (!origin) return;

    map.easeTo({
      center: [
        origin.lon,
        origin.lat
      ],
      zoom: 11.5,
      duration: 650
    });
  }
);

map.on('error', event => {
  const message = String(
    event?.error?.message || ''
  );

  if (
    /401|403|api key|token/i
      .test(message)
  ) {
    setStatus(
      '底图服务响应异常，请刷新页面重试。',
      true
    );
  }
});

syncDurationControl();
