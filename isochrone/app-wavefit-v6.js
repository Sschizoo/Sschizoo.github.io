const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const SEGMENT_MINUTES = 60;
const MAX_DURATION_MINUTES = 30 * 24 * 60;
const LIVE_WAVE_LIMIT = 3;
const FRONTIER_COUNT = 5;
const FRONTIER_SECTORS = 20;
const PROFILE_SECTORS = 72;
const REQUEST_CONCURRENCY = 2;
const DISPLAY_CONTOURS = 4;
const MAX_FIT_DISTANCE_KM = 9000;

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
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function waitForMapLoad() {
  if (map.loaded()) return Promise.resolve();
  return new Promise(resolve => map.once('load', resolve));
}

function setOrigin(lat, lon, label) {
  origin = { lat:Number(lat), lon:Number(lon), label };

  if (originMarker) originMarker.remove();

  const el = document.createElement('div');
  el.className = 'origin-marker';
  el.innerHTML = '<span></span>';

  originMarker = new maplibregl.Marker({
    element:el,
    anchor:'center'
  })
    .setLngLat([origin.lon, origin.lat])
    .setPopup(
      new maplibregl.Popup({
        offset:16,
        closeButton:false
      }).setHTML('<strong>起点</strong><br>' + escapeHtml(label))
    )
    .addTo(map);

  placeName.textContent = label;
  placeCard.classList.remove('hidden');
  recenterBtn.classList.remove('hidden');
  generateBtn.disabled = false;

  map.easeTo({
    center:[origin.lon, origin.lat],
    zoom:Math.max(map.getZoom(), 11.5),
    duration:750
  });
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

  const fitted = minutes > SEGMENT_MINUTES;

  durationModeLabel.textContent =
    fitted ? '多波次道路拟合 · Demo' : '真实道路 · Valhalla';

  durationModeLabel.classList.toggle('estimate', fitted);

  if (!minutes) {
    durationHint.textContent = '请输入驾驶时长。';
  } else if (fitted) {
    durationHint.textContent =
      '先用多个真实 60 分钟道路等时圈逐波传播并拼接，最多实算 3 小时；更长时程再按各方向真实增长曲线拟合外推。';
  } else {
    durationHint.textContent = '当前使用真实 OSM 道路网络计算。';
  }
}

function colorForRatio(ratio) {
  if (ratio <= 0.25) return '#0b6f72';
  if (ratio <= 0.50) return '#238b8e';
  if (ratio <= 0.75) return '#58adb0';
  return '#9bd2d8';
}

function buildDisplayTimes(maxMinutes) {
  const values = [];
  for (let i = 1; i <= DISPLAY_CONTOURS; i++) {
    values.push(Math.max(1, Math.round(maxMinutes * i / DISPLAY_CONTOURS)));
  }
  return [...new Set(values)];
}

function renderLegend(minutesList, fitted) {
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
    (fitted
      ? '<span class="legend-mode">多轮真实 60 分钟传播 + 方向拟合 · 演示近似</span>'
      : '');

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
    headers:{'Accept':'application/json'}
  });

  if (!response.ok) {
    throw new Error('地点搜索服务暂时不可用（' + response.status + '）。');
  }

  const data = await response.json();
  geocodeCache.set(query, data);
  return data;
}

async function requestIsochrone(point, contours) {
  const safeContours =
    [...new Set(contours)]
      .map(v => Math.max(1, Math.min(SEGMENT_MINUTES, Math.round(v))))
      .sort((a,b) => a-b)
      .slice(0, 4);

  const payload = {
    id:'sschizoo-wavefit-demo',
    locations:[{lat:point.lat, lon:point.lon}],
    costing:'auto',
    contours:safeContours.map((minutes, index) => ({
      time:minutes,
      color:colorForRatio((index + 1) / safeContours.length).replace('#','')
    })),
    polygons:true,
    denoise:0.12,
    generalize:35
  };

  const url =
    VALHALLA_BASE +
    '/isochrone?json=' +
    encodeURIComponent(JSON.stringify(payload));

  const response = await fetch(url, {
    headers:{'Accept':'application/json'}
  });

  let body = null;
  try { body = await response.json(); } catch (_) {}

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('公共 Valhalla 请求过多，请稍后再试。');
    }
    const detail = body?.error || body?.status || ('HTTP ' + response.status);
    throw new Error('真实道路等时圈生成失败：' + detail);
  }

  if (!body?.features?.length) {
    throw new Error('该位置附近没有返回可用道路等时圈。');
  }

  return body;
}

function contourValue(feature) {
  return Number(
    feature?.properties?.contour ??
    feature?.properties?.time ??
    0
  );
}

function featuresForContour(body, target) {
  return (body.features || []).filter(feature =>
    Math.abs(contourValue(feature) - target) < 0.75 &&
    /Polygon/.test(feature.geometry?.type || '')
  );
}

function unionFeatures(features) {
  const polygons = features.filter(feature =>
    feature &&
    /Polygon/.test(feature.geometry?.type || '')
  );

  if (!polygons.length) return null;
  if (polygons.length === 1) return structuredClone(polygons[0]);

  try {
    const cleaned = polygons.map(feature => {
      try {
        return turf.cleanCoords(feature);
      } catch (_) {
        return feature;
      }
    });

    return turf.union(turf.featureCollection(cleaned));
  } catch (error) {
    console.warn('Polygon union fallback:', error);

    // 回退：选面积最大的多边形，避免整次 Demo 因几何拓扑异常失败。
    let best = polygons[0];
    let bestArea = 0;

    for (const feature of polygons) {
      let area = 0;
      try { area = turf.area(feature); } catch (_) {}
      if (area > bestArea) {
        best = feature;
        bestArea = area;
      }
    }

    return structuredClone(best);
  }
}

function inverseGeodesic(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;

  const c =
    2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));

  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) -
    Math.sin(p1) * Math.cos(p2) * Math.cos(dl);

  return {
    distanceKm:R * c,
    bearing:(Math.atan2(y, x) * 180 / Math.PI + 360) % 360
  };
}

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const R = 6371.0088;
  const delta = Math.min(distanceKm, MAX_FIT_DISTANCE_KM) / R;
  const theta = bearingDeg * Math.PI / 180;
  const phi1 = lat * Math.PI / 180;
  const lambda1 = lon * Math.PI / 180;

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) +
    Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);

  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));

  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2);

  let lambda2 = lambda1 + Math.atan2(y, x);
  lambda2 = ((lambda2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

  return [
    lambda2 * 180 / Math.PI,
    phi2 * 180 / Math.PI
  ];
}

function outerRingCoordinates(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return [];

  if (geometry.type === 'Polygon') {
    return geometry.coordinates?.[0] || [];
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map(poly => poly?.[0] || [])
      .flat();
  }

  return [];
}

function radialProfile(feature, sectors = PROFILE_SECTORS) {
  const radii = new Array(sectors).fill(0);
  const ring = outerRingCoordinates(feature);

  for (const coord of ring) {
    const lon = Number(coord[0]);
    const lat = Number(coord[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const inv = inverseGeodesic(origin.lat, origin.lon, lat, lon);
    const idx =
      Math.floor((inv.bearing / 360) * sectors) % sectors;

    if (inv.distanceKm > radii[idx]) {
      radii[idx] = inv.distanceKm;
    }
  }

  fillCircularGaps(radii);
  return smoothCircular(radii, 2);
}

function fillCircularGaps(values) {
  const n = values.length;
  const nonzero = values
    .map((value, index) => value > 0 ? index : -1)
    .filter(index => index >= 0);

  if (!nonzero.length) return values;
  if (nonzero.length === 1) {
    values.fill(values[nonzero[0]]);
    return values;
  }

  for (let i = 0; i < n; i++) {
    if (values[i] > 0) continue;

    let left = i;
    while (values[(left - 1 + n) % n] === 0) {
      left = (left - 1 + n) % n;
      if (left === i) break;
    }
    left = (left - 1 + n) % n;

    let right = i;
    while (values[(right + 1) % n] === 0) {
      right = (right + 1) % n;
      if (right === i) break;
    }
    right = (right + 1) % n;

    const leftValue = values[left];
    const rightValue = values[right];

    if (leftValue > 0 && rightValue > 0) {
      values[i] = (leftValue + rightValue) / 2;
    } else {
      values[i] = Math.max(leftValue, rightValue);
    }
  }

  return values;
}

function smoothCircular(values, radius) {
  const n = values.length;
  const out = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    let sum = 0;
    let weightSum = 0;

    for (let d = -radius; d <= radius; d++) {
      const idx = (i + d + n) % n;
      const weight = radius + 1 - Math.abs(d);
      sum += values[idx] * weight;
      weightSum += weight;
    }

    out[i] = sum / weightSum;
  }

  return out;
}

function selectFrontierPoints(feature, count = FRONTIER_COUNT) {
  const ring = outerRingCoordinates(feature);
  const bins = new Array(FRONTIER_SECTORS).fill(null);

  for (const coord of ring) {
    const lon = Number(coord[0]);
    const lat = Number(coord[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const inv = inverseGeodesic(origin.lat, origin.lon, lat, lon);
    const idx =
      Math.floor((inv.bearing / 360) * FRONTIER_SECTORS) %
      FRONTIER_SECTORS;

    if (!bins[idx] || inv.distanceKm > bins[idx].distanceKm) {
      bins[idx] = {
        lat,
        lon,
        distanceKm:inv.distanceKm,
        bearing:inv.bearing,
        sector:idx
      };
    }
  }

  const candidates =
    bins.filter(Boolean).sort((a,b) => a.sector - b.sector);

  if (candidates.length <= count) {
    return candidates.map(({lat,lon}) => ({lat,lon}));
  }

  const selected = [];
  for (let i = 0; i < count; i++) {
    const index =
      Math.floor(i * candidates.length / count);
    selected.push(candidates[index]);
  }

  return selected.map(({lat,lon}) => ({lat,lon}));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker(workerId) {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;

      if (index > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, 180 + workerId * 80)
        );
      }

      results[index] = await worker(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(runWorker(i));
  }

  await Promise.all(workers);
  return results;
}

function addSnapshot(map, time, feature) {
  if (!feature) return;
  feature.properties = {
    ...(feature.properties || {}),
    contour:time,
    observed:true
  };
  map.set(Math.round(time), feature);
}

async function buildObservedSnapshots(targetMinutes) {
  const snapshots = new Map();

  if (targetMinutes <= SEGMENT_MINUTES) {
    const times = buildDisplayTimes(targetMinutes);
    const first = await requestIsochrone(origin, times);

    for (const time of times) {
      const merged = unionFeatures(featuresForContour(first, time));
      addSnapshot(snapshots, time, merged);
    }

    return snapshots;
  }

  setStatus('第 1 波：计算起点 60 分钟真实道路范围…');

  const first = await requestIsochrone(
    origin,
    [15, 30, 45, 60]
  );

  for (const time of [15,30,45,60]) {
    const merged = unionFeatures(featuresForContour(first, time));
    addSnapshot(snapshots, time, merged);
  }

  let current =
    snapshots.get(60) ||
    unionFeatures(featuresForContour(first, 60));

  if (!current) {
    throw new Error('无法取得第 1 波 60 分钟道路边界。');
  }

  const fullHours =
    Math.min(
      LIVE_WAVE_LIMIT,
      Math.floor(targetMinutes / SEGMENT_MINUTES)
    );

  for (let wave = 2; wave <= fullHours; wave++) {
    const frontier =
      selectFrontierPoints(current, FRONTIER_COUNT);

    if (!frontier.length) break;

    setStatus(
      '第 ' + wave + ' 波：从 ' +
      frontier.length +
      ' 个道路前沿点继续传播 60 分钟…'
    );

    const responses =
      await mapWithConcurrency(
        frontier,
        REQUEST_CONCURRENCY,
        point => requestIsochrone(point, [SEGMENT_MINUTES])
      );

    const wavePolygons =
      responses.flatMap(body =>
        featuresForContour(body, SEGMENT_MINUTES)
      );

    current =
      unionFeatures([
        current,
        ...wavePolygons
      ]) || current;

    addSnapshot(
      snapshots,
      wave * SEGMENT_MINUTES,
      current
    );
  }

  if (targetMinutes <= LIVE_WAVE_LIMIT * SEGMENT_MINUTES) {
    const remainder =
      targetMinutes % SEGMENT_MINUTES;

    if (
      remainder > 0 &&
      !snapshots.has(Math.round(targetMinutes))
    ) {
      const baseTime =
        Math.floor(targetMinutes / SEGMENT_MINUTES) *
        SEGMENT_MINUTES;

      const base =
        snapshots.get(baseTime);

      if (base) {
        const frontier =
          selectFrontierPoints(base, FRONTIER_COUNT);

        setStatus(
          '补充波：从道路前沿继续传播 ' +
          formatDuration(remainder) +
          '…'
        );

        const responses =
          await mapWithConcurrency(
            frontier,
            REQUEST_CONCURRENCY,
            point => requestIsochrone(point, [remainder])
          );

        const partial =
          responses.flatMap(body =>
            featuresForContour(body, remainder)
          );

        addSnapshot(
          snapshots,
          targetMinutes,
          unionFeatures([base, ...partial]) || base
        );
      }
    }
  }

  return snapshots;
}

function snapshotProfiles(snapshots) {
  return [...snapshots.entries()]
    .filter(([time, feature]) =>
      time > 0 &&
      feature &&
      /Polygon/.test(feature.geometry?.type || '')
    )
    .sort((a,b) => a[0] - b[0])
    .map(([time, feature]) => ({
      time,
      profile:radialProfile(feature)
    }));
}

function interpolateProfiles(a, b, ratio) {
  const out = new Array(PROFILE_SECTORS);

  for (let i = 0; i < PROFILE_SECTORS; i++) {
    out[i] =
      a[i] +
      (b[i] - a[i]) * ratio;
  }

  return smoothCircular(out, 1);
}

function fitPowerLawForSector(observations, sector, targetTime) {
  const usable =
    observations
      .filter(obs =>
        obs.time >= 45 &&
        obs.profile[sector] > 0.2
      )
      .slice(-4);

  if (!usable.length) return 0;

  if (usable.length === 1) {
    const only = usable[0];
    return Math.min(
      MAX_FIT_DISTANCE_KM,
      only.profile[sector] *
      Math.pow(targetTime / only.time, 0.72)
    );
  }

  const xs = usable.map(obs => Math.log(obs.time));
  const ys = usable.map(obs => Math.log(obs.profile[sector]));

  const xMean = xs.reduce((a,b) => a+b,0) / xs.length;
  const yMean = ys.reduce((a,b) => a+b,0) / ys.length;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < xs.length; i++) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }

  let exponent =
    denominator > 1e-9
      ? numerator / denominator
      : 0.72;

  exponent = Math.max(0.18, Math.min(1.08, exponent));

  const intercept =
    yMean - exponent * xMean;

  const predicted =
    Math.exp(intercept) *
    Math.pow(targetTime, exponent);

  const last = usable[usable.length - 1].profile[sector];

  return Math.min(
    MAX_FIT_DISTANCE_KM,
    Math.max(last, predicted)
  );
}

function profileAtTime(observations, targetTime) {
  if (!observations.length) {
    throw new Error('没有足够的道路传播样本进行拟合。');
  }

  const exact =
    observations.find(obs =>
      Math.abs(obs.time - targetTime) < 0.5
    );

  if (exact) return exact.profile;

  const before =
    [...observations]
      .reverse()
      .find(obs => obs.time < targetTime);

  const after =
    observations.find(obs => obs.time > targetTime);

  if (before && after) {
    const ratio =
      (targetTime - before.time) /
      (after.time - before.time);

    return interpolateProfiles(
      before.profile,
      after.profile,
      ratio
    );
  }

  if (!before && after) {
    const scale =
      targetTime / after.time;

    return after.profile.map(radius =>
      radius * Math.max(0.05, scale)
    );
  }

  const fitted =
    new Array(PROFILE_SECTORS);

  for (let sector = 0; sector < PROFILE_SECTORS; sector++) {
    fitted[sector] =
      fitPowerLawForSector(
        observations,
        sector,
        targetTime
      );
  }

  return smoothCircular(fitted, 2);
}

function polygonFromProfile(profile, time, observed = false) {
  const ring = [];

  for (let i = 0; i < PROFILE_SECTORS; i++) {
    const bearing =
      (i + 0.5) * 360 / PROFILE_SECTORS;

    ring.push(
      destinationPoint(
        origin.lat,
        origin.lon,
        bearing,
        profile[i]
      )
    );
  }

  ring.push(ring[0]);

  return {
    type:'Feature',
    properties:{
      contour:time,
      observed
    },
    geometry:{
      type:'Polygon',
      coordinates:[ring]
    }
  };
}

function featureAtTime(snapshots, observations, time) {
  const exact =
    snapshots.get(Math.round(time));

  if (
    exact &&
    Math.abs(Math.round(time) - time) < 0.5
  ) {
    const copy = structuredClone(exact);
    copy.properties = {
      ...(copy.properties || {}),
      contour:time,
      observed:true
    };
    return copy;
  }

  return polygonFromProfile(
    profileAtTime(observations, time),
    time,
    false
  );
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
    bounds.extend([coords[0],coords[1]]);
    return;
  }

  for (const item of coords) {
    extendBoundsFromCoordinates(item,bounds);
  }
}

function fitGeoJSON(features) {
  const bounds = new maplibregl.LngLatBounds();

  for (const feature of features) {
    extendBoundsFromCoordinates(
      feature.geometry?.coordinates,
      bounds
    );
  }

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, {
      padding:{
        top:70,
        right:70,
        bottom:70,
        left:window.innerWidth <= 760 ? 70 : 430
      },
      duration:900,
      maxZoom:11
    });
  }
}

async function drawResult(features, displayTimes) {
  await waitForMapLoad();
  clearIsochroneLayers();

  const sorted =
    [...features].sort(
      (a,b) =>
        Number(b.properties?.contour || 0) -
        Number(a.properties?.contour || 0)
    );

  map.addSource('isochrones', {
    type:'geojson',
    data:{
      type:'FeatureCollection',
      features:sorted
    }
  });

  const beforeId = findFirstSymbolLayer();
  const max = Math.max(...displayTimes);

  [...displayTimes]
    .sort((a,b) => b-a)
    .forEach((time,index) => {
      const fillId = 'iso-fill-' + index;
      const lineId = 'iso-line-' + index;
      const color = colorForRatio(time / max);

      const filter = [
        '==',
        ['to-number',['get','contour']],
        time
      ];

      map.addLayer({
        id:fillId,
        type:'fill',
        source:'isochrones',
        filter,
        paint:{
          'fill-color':color,
          'fill-opacity':[
            'case',
            ['boolean',['get','observed'],false],
            0.18,
            0.14
          ]
        }
      }, beforeId);

      map.addLayer({
        id:lineId,
        type:'line',
        source:'isochrones',
        filter,
        paint:{
          'line-color':color,
          'line-width':[
            'case',
            ['boolean',['get','observed'],false],
            1.6,
            2.0
          ],
          'line-opacity':0.94
        }
      }, beforeId);

      contourLayerIds.push(fillId,lineId);
    });

  fitGeoJSON(sorted);
}

searchForm.addEventListener('submit', async event => {
  event.preventDefault();

  const query = placeInput.value.trim();
  if (!query) return;

  setBusy(true);
  setStatus('正在查找地点…');

  try {
    const data = await geocode(query);

    if (!data.length) {
      throw new Error('没有找到这个地点，请尝试更具体的名称。');
    }

    const best = data[0];

    setOrigin(
      best.lat,
      best.lon,
      best.display_name || query
    );

    setStatus('地点已定位。输入驾驶时长后即可生成。');
  } catch (error) {
    setStatus(error.message || '地点查找失败。', true);
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
    position => {
      setOrigin(
        position.coords.latitude,
        position.coords.longitude,
        '设备当前位置'
      );
      setStatus('已获取当前位置。');
      locateBtn.disabled = false;
    },
    error => {
      const message =
        error.code === 1
          ? '定位权限被拒绝，请在浏览器设置中允许定位。'
          : '无法获取当前位置，请改为输入地点。';

      setStatus(message,true);
      locateBtn.disabled = false;
    },
    {
      enableHighAccuracy:true,
      timeout:10000,
      maximumAge:60000
    }
  );
});

durationInput.addEventListener('input', syncDurationControl);

durationUnit.addEventListener('change', () => {
  const value = Number(durationInput.value);

  if (durationUnit.value === 'day' && value > 30) {
    durationInput.value = '30';
  }

  if (durationUnit.value === 'hour' && value > 720) {
    durationInput.value = '720';
  }

  syncDurationControl();
});

generateBtn.addEventListener('click', async () => {
  if (!origin) {
    setStatus('请先选择起点。',true);
    return;
  }

  let maxMinutes;
  try {
    maxMinutes = getDurationMinutes();
  } catch (error) {
    setStatus(error.message,true);
    return;
  }

  setBusy(true);

  try {
    const fitted = maxMinutes > SEGMENT_MINUTES;

    setStatus(
      fitted
        ? '开始多波次道路传播，正在调用多个真实 60 分钟等时圈…'
        : '正在计算真实道路网络等时圈…'
    );

    const snapshots =
      await buildObservedSnapshots(maxMinutes);

    const observations =
      snapshotProfiles(snapshots);

    const displayTimes =
      buildDisplayTimes(maxMinutes);

    const features =
      displayTimes.map(time =>
        featureAtTime(
          snapshots,
          observations,
          time
        )
      );

    setStatus('正在拼接边界并进行方向拟合…');

    await drawResult(
      features,
      displayTimes
    );

    renderLegend(
      displayTimes,
      fitted
    );

    const maxObserved =
      observations.length
        ? observations[observations.length - 1].time
        : Math.min(maxMinutes,60);

    setStatus(
      fitted
        ? '已生成 ' +
          formatDuration(maxMinutes) +
          ' Demo 等时圈：真实道路传播实算至 ' +
          formatDuration(maxObserved) +
          '，其余时程按 72 个方向的真实增长曲线拟合。'
        : '已生成 ' +
          formatDuration(maxMinutes) +
          ' 的真实道路网络等时圈。'
    );
  } catch (error) {
    console.error(error);
    setStatus(
      error.message || '等时圈生成失败，请稍后重试。',
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
    center:[origin.lon,origin.lat],
    zoom:11.5,
    duration:650
  });
});

map.on('error', event => {
  const message = String(event?.error?.message || '');

  if (/401|403|api key|token/i.test(message)) {
    setStatus('底图服务响应异常，请刷新页面重试。',true);
  }
});

syncDurationControl();
