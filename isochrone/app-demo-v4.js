const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const EXACT_MAX_MINUTES = 120;
const MAX_DURATION_MINUTES = 30 * 24 * 60;
const CONTOUR_COUNT = 4;

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

const $ = id => document.getElementById(id);

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

  const approximate = minutes > EXACT_MAX_MINUTES;

  durationModeLabel.textContent =
    approximate
      ? '道路形状外推 · Demo'
      : '真实道路 · Valhalla';

  durationModeLabel.classList.toggle(
    'estimate',
    approximate
  );

  if (!minutes) {
    durationHint.textContent =
      '请输入驾驶时长。';
  } else if (approximate) {
    durationHint.textContent =
      '超过 120 分钟后，先计算真实 120 分钟道路边界，再保持其方向性和不规则轮廓做测地线外推；适合演示，不代表导航级精度。';
  } else {
    durationHint.textContent =
      '当前使用真实 OSM 道路网络计算。';
  }
}

function colorForRatio(ratio) {
  if (ratio <= 0.25) return '#0b6f72';
  if (ratio <= 0.50) return '#238b8e';
  if (ratio <= 0.75) return '#58adb0';
  return '#9bd2d8';
}

function buildDisplayContours(maxMinutes) {
  const values = [];

  for (let i = 1; i <= CONTOUR_COUNT; i++) {
    values.push(
      Math.max(
        1,
        Math.round(maxMinutes * i / CONTOUR_COUNT)
      )
    );
  }

  return [...new Set(values)];
}

function renderLegend(minutesList, approximate) {
  const max = Math.max(...minutesList);

  legend.innerHTML =
    minutesList.map(minutes => (
      '<span class="legend-item">' +
        '<i class="legend-swatch" style="background:' +
        colorForRatio(minutes / max) +
        '"></i>' +
        formatDuration(minutes) +
      '</span>'
    )).join('') +
    (
      approximate
        ? '<span class="legend-mode">120 分钟以上为道路形状外推 · 演示近似</span>'
        : ''
    );

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

async function requestValhallaContours(contours) {
  const uniqueContours =
    [...new Set(contours)]
      .filter(v => v > 0 && v <= EXACT_MAX_MINUTES)
      .sort((a, b) => a - b)
      .slice(0, 4);

  if (!uniqueContours.length) {
    throw new Error('没有可请求的真实道路 contour。');
  }

  const payload = {
    id: 'sschizoo-demo-isochrone',
    locations: [{
      lat: origin.lat,
      lon: origin.lon
    }],
    costing: 'auto',
    contours: uniqueContours.map((minutes, index) => ({
      time: minutes,
      color: colorForRatio(
        (index + 1) / uniqueContours.length
      ).replace('#', '')
    })),
    polygons: true,
    denoise: 0.18,
    generalize: 40
  };

  const url =
    VALHALLA_BASE +
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

  return body;
}

function getContourValue(feature) {
  return Number(
    feature?.properties?.contour ??
    feature?.properties?.time ??
    0
  );
}

function findFeatureForContour(features, target) {
  let best = null;
  let bestDiff = Infinity;

  for (const feature of features) {
    const value = getContourValue(feature);
    const diff = Math.abs(value - target);

    if (diff < bestDiff) {
      best = feature;
      bestDiff = diff;
    }
  }

  return best;
}

function toRadians(deg) {
  return deg * Math.PI / 180;
}

function toDegrees(rad) {
  return rad * 180 / Math.PI;
}

function inverseGeodesic(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;

  const p1 = toRadians(lat1);
  const p2 = toRadians(lat2);
  const dp = toRadians(lat2 - lat1);
  const dl = toRadians(lon2 - lon1);

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
    Math.cos(p2) *
    Math.sin(dl / 2) ** 2;

  const c =
    2 * Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  const y =
    Math.sin(dl) * Math.cos(p2);

  const x =
    Math.cos(p1) * Math.sin(p2) -
    Math.sin(p1) *
    Math.cos(p2) *
    Math.cos(dl);

  const bearing =
    (toDegrees(Math.atan2(y, x)) + 360) % 360;

  return {
    distanceKm: R * c,
    bearing
  };
}

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const R = 6371.0088;
  const delta = Math.min(distanceKm, 9500) / R;
  const theta = toRadians(bearingDeg);
  const phi1 = toRadians(lat);
  const lambda1 = toRadians(lon);

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) +
    Math.cos(phi1) *
    Math.sin(delta) *
    Math.cos(theta);

  const phi2 =
    Math.asin(
      Math.max(
        -1,
        Math.min(1, sinPhi2)
      )
    );

  const y =
    Math.sin(theta) *
    Math.sin(delta) *
    Math.cos(phi1);

  const x =
    Math.cos(delta) -
    Math.sin(phi1) *
    Math.sin(phi2);

  let lambda2 =
    lambda1 + Math.atan2(y, x);

  lambda2 =
    ((lambda2 + 3 * Math.PI) %
      (2 * Math.PI)) -
    Math.PI;

  return [
    toDegrees(lambda2),
    toDegrees(phi2)
  ];
}

function extrapolationScale(targetMinutes) {
  const ratio =
    Math.max(1, targetMinutes / EXACT_MAX_MINUTES);

  // 前几小时增长较快，超长时程逐渐压缩，避免 30 天直接铺满全球。
  if (ratio <= 3) {
    return 1 + 0.72 * (ratio - 1);
  }

  if (ratio <= 12) {
    return 2.44 + 0.50 * (ratio - 3);
  }

  if (ratio <= 84) {
    return 6.94 + 0.22 * (ratio - 12);
  }

  return Math.min(
    70,
    22.78 + 0.10 * (ratio - 84)
  );
}

function scaleCoordinate(coord, targetMinutes) {
  const lon = Number(coord[0]);
  const lat = Number(coord[1]);

  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat)
  ) {
    return coord;
  }

  const inv =
    inverseGeodesic(
      origin.lat,
      origin.lon,
      lat,
      lon
    );

  const scale =
    extrapolationScale(targetMinutes);

  const distance =
    Math.min(
      9500,
      inv.distanceKm * scale
    );

  return destinationPoint(
    origin.lat,
    origin.lon,
    inv.bearing,
    distance
  );
}

function scaleGeometryCoordinates(value, targetMinutes) {
  if (!Array.isArray(value)) {
    return value;
  }

  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    return scaleCoordinate(
      value,
      targetMinutes
    );
  }

  return value.map(item =>
    scaleGeometryCoordinates(
      item,
      targetMinutes
    )
  );
}

function extrapolateFeature(baseFeature, targetMinutes) {
  return {
    type: 'Feature',
    properties: {
      contour: targetMinutes,
      approximate: true,
      source_contour: EXACT_MAX_MINUTES
    },
    geometry: {
      type: baseFeature.geometry.type,
      coordinates:
        scaleGeometryCoordinates(
          baseFeature.geometry.coordinates,
          targetMinutes
        )
    }
  };
}

async function buildDemoFeatures(maxMinutes) {
  const desired =
    buildDisplayContours(maxMinutes);

  const exactDesired =
    desired.filter(
      minutes => minutes <= EXACT_MAX_MINUTES
    );

  const needsApprox =
    desired.some(
      minutes => minutes > EXACT_MAX_MINUTES
    );

  const requestContours =
    [...exactDesired];

  if (
    needsApprox &&
    !requestContours.includes(EXACT_MAX_MINUTES)
  ) {
    requestContours.push(
      EXACT_MAX_MINUTES
    );
  }

  // FOSSGIS 公共实例最多 4 条 contour。
  // 保留所有需要显示的精确 contour，并确保有 120 分钟模板。
  while (requestContours.length > 4) {
    requestContours.splice(
      requestContours.length - 2,
      1
    );
  }

  const body =
    await requestValhallaContours(
      requestContours
    );

  const sourceFeatures =
    body.features || [];

  const base120 =
    needsApprox
      ? findFeatureForContour(
          sourceFeatures,
          EXACT_MAX_MINUTES
        )
      : null;

  if (
    needsApprox &&
    !base120
  ) {
    throw new Error(
      '未能取得 120 分钟真实道路模板，无法执行道路形状外推。'
    );
  }

  const features = [];

  for (const minutes of desired) {
    if (minutes <= EXACT_MAX_MINUTES) {
      const feature =
        findFeatureForContour(
          sourceFeatures,
          minutes
        );

      if (feature) {
        feature.properties = {
          ...(feature.properties || {}),
          contour: minutes,
          approximate: false
        };

        features.push(feature);
      }
    } else {
      features.push(
        extrapolateFeature(
          base120,
          minutes
        )
      );
    }
  }

  return {
    body: {
      type: 'FeatureCollection',
      features
    },
    minutesList: desired,
    approximate: needsApprox
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
  const layers =
    map.getStyle()?.layers || [];

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
      duration: 900,
      maxZoom: 11
    });
  }
}

async function drawIsochrones(result) {
  await waitForMapLoad();
  clearIsochroneLayers();

  const features =
    [...result.body.features]
      .sort(
        (a, b) =>
          Number(b.properties?.contour || 0) -
          Number(a.properties?.contour || 0)
      );

  map.addSource('isochrones', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features
    }
  });

  const beforeId =
    findFirstSymbolLayer();

  const max =
    Math.max(...result.minutesList);

  const descending =
    [...result.minutesList]
      .sort((a, b) => b - a);

  descending.forEach((minutes, index) => {
    const fillId =
      'iso-fill-' + index;

    const lineId =
      'iso-line-' + index;

    const color =
      colorForRatio(
        minutes / max
      );

    const filter = [
      '==',
      ['to-number', ['get', 'contour']],
      minutes
    ];

    map.addLayer({
      id: fillId,
      type: 'fill',
      source: 'isochrones',
      filter,
      paint: {
        'fill-color': color,
        'fill-opacity': [
          'case',
          ['boolean', ['get', 'approximate'], false],
          0.13,
          0.18
        ]
      }
    }, beforeId);

    map.addLayer({
      id: lineId,
      type: 'line',
      source: 'isochrones',
      filter,
      paint: {
        'line-color': color,
        'line-width': [
          'case',
          ['boolean', ['get', 'approximate'], false],
          2.2,
          1.5
        ],
        'line-opacity': 0.94
      }
    }, beforeId);

    contourLayerIds.push(
      fillId,
      lineId
    );
  });

  fitGeoJSON(features);
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
        '地点已定位。输入驾驶时长后即可生成。'
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

    setBusy(true);

    try {
      const approximate =
        maxMinutes > EXACT_MAX_MINUTES;

      setStatus(
        approximate
          ? '正在计算真实 120 分钟道路模板，并生成 ' +
            formatDuration(maxMinutes) +
            ' 的道路形状外推边界…'
          : '正在沿真实道路网络计算 ' +
            formatDuration(maxMinutes) +
            ' 可达范围…'
      );

      const result =
        await buildDemoFeatures(
          maxMinutes
        );

      await drawIsochrones(
        result
      );

      renderLegend(
        result.minutesList,
        result.approximate
      );

      setStatus(
        result.approximate
          ? '已生成 ' +
            formatDuration(maxMinutes) +
            ' 演示等时圈：120 分钟内为真实道路结果，外层保持真实道路边界形状做测地线外推。'
          : '已生成 ' +
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
  const message =
    String(
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
