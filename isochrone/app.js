const ORS_BASE = 'https://api.heigit.org/openrouteservice/v2';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const KEY_STORAGE = 'driveIsochrone.orsKey';

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
const settingsDialog = $('settingsDialog');
const apiKeyInput = $('apiKeyInput');
const recenterBtn = $('recenterBtn');

let origin = null;
let originMarker = null;
let isoLayer = null;
const geocodeCache = new Map();

function setStatus(text, error=false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}
function setBusy(isBusy) {
  generateBtn.disabled = isBusy || !origin;
  searchForm.querySelector('button').disabled = isBusy;
  locateBtn.disabled = isBusy;
}
function setOrigin(lat, lon, label) {
  origin = { lat:Number(lat), lon:Number(lon), label };
  if (originMarker) originMarker.remove();
  originMarker = L.marker([origin.lat, origin.lon]).addTo(map)
    .bindPopup('<strong>起点</strong><br>' + escapeHtml(label));
  placeName.textContent = label;
  placeCard.classList.remove('hidden');
  recenterBtn.classList.remove('hidden');
  generateBtn.disabled = false;
  map.flyTo([origin.lat, origin.lon], Math.max(map.getZoom(), 12), {duration:.7});
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function getKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
function openSettings() {
  apiKeyInput.value = getKey();
  settingsDialog.showModal();
}
function colorFor(minutes) {
  if (minutes <= 10) return '#2f80ed';
  if (minutes <= 20) return '#27ae60';
  if (minutes <= 30) return '#f2c94c';
  if (minutes <= 40) return '#f2994a';
  if (minutes <= 50) return '#eb5757';
  return '#9b51e0';
}
function buildRanges(maxMin) {
  const arr=[]; for(let m=10;m<=maxMin;m+=10) arr.push(m*60); return arr;
}
function renderLegend(ranges) {
  legend.innerHTML = ranges.map(s => {
    const m=s/60;
    return '<span class="legend-item"><i class="legend-swatch" style="background:'+colorFor(m)+'"></i>'+m+' 分钟</span>';
  }).join('');
  legend.classList.remove('hidden');
}

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = placeInput.value.trim();
  if (!q) return;
  setBusy(true); setStatus('正在查找地点…');
  try {
    let data = geocodeCache.get(q);
    if (!data) {
      const url = NOMINATIM + '?format=jsonv2&limit=5&accept-language=zh-CN&q=' + encodeURIComponent(q);
      const res = await fetch(url, {headers:{'Accept':'application/json'}});
      if (!res.ok) throw new Error('地理编码服务返回 ' + res.status);
      data = await res.json();
      geocodeCache.set(q, data);
    }
    if (!data.length) throw new Error('没有找到这个地点，请尝试更具体的名称。');
    const best = data[0];
    setOrigin(best.lat, best.lon, best.display_name || q);
    setStatus('地点已定位。选择时间后生成等时圈。');
  } catch (err) {
    setStatus(err.message || '地点查找失败。', true);
  } finally { setBusy(false); }
});

locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('当前浏览器不支持定位。', true);
  setStatus('正在获取设备位置…');
  locateBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    pos => {
      setOrigin(pos.coords.latitude, pos.coords.longitude, '设备当前位置');
      setStatus('已获取当前位置。');
      locateBtn.disabled = false;
    },
    err => {
      const msg = err.code === 1 ? '定位权限被拒绝，请在浏览器设置中允许定位。' : '无法获取当前位置，请改为输入地点。';
      setStatus(msg, true); locateBtn.disabled = false;
    },
    {enableHighAccuracy:true, timeout:10000, maximumAge:60000}
  );
});

timeRange.addEventListener('input', () => { timeLabel.textContent = timeRange.value + ' 分钟'; });

generateBtn.addEventListener('click', async () => {
  if (!origin) return;
  const key = getKey();
  if (!key) {
    setStatus('请先设置 openrouteservice API Key。', true);
    return openSettings();
  }
  const ranges = buildRanges(Number(timeRange.value));
  setBusy(true); setStatus('正在计算道路网络可达范围…');
  try {
    const res = await fetch(ORS_BASE + '/isochrones/driving-car', {
      method:'POST',
      headers:{'Authorization':key,'Content-Type':'application/json','Accept':'application/geo+json'},
      body:JSON.stringify({
        locations:[[origin.lon, origin.lat]],
        range:ranges,
        range_type:'time',
        location_type:'start',
        smoothing:0.35
      })
    });
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const detail = body?.error?.message || body?.error || ('HTTP ' + res.status);
      throw new Error('等时圈生成失败：' + detail);
    }
    if (!body?.features?.length) throw new Error('服务没有返回可用的等时圈。');
    if (isoLayer) isoLayer.remove();

    const sorted = [...body.features].sort((a,b)=>(b.properties?.value||0)-(a.properties?.value||0));
    isoLayer = L.geoJSON({type:'FeatureCollection',features:sorted}, {
      style: feature => {
        const minutes = Math.round((feature.properties?.value || 0)/60);
        return {color:colorFor(minutes), weight:2, fillColor:colorFor(minutes), fillOpacity:.16, opacity:.9};
      },
      onEachFeature: (feature, layer) => {
        const minutes = Math.round((feature.properties?.value || 0)/60);
        layer.bindTooltip(minutes + ' 分钟可达范围');
      }
    }).addTo(map);
    map.fitBounds(isoLayer.getBounds(), {padding:[26,26]});
    renderLegend(ranges);
    setStatus('已生成 '+ranges.length+' 个驾驶时间圈。');
  } catch (err) {
    setStatus(err.message || '等时圈生成失败，请检查 API Key 和网络。', true);
  } finally { setBusy(false); }
});

$('settingsBtn').addEventListener('click', openSettings);
$('saveKeyBtn').addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) return setStatus('API Key 不能为空。', true);
  localStorage.setItem(KEY_STORAGE, key);
  settingsDialog.close();
  setStatus('API Key 已保存在当前浏览器。');
});
$('clearKeyBtn').addEventListener('click', () => {
  localStorage.removeItem(KEY_STORAGE); apiKeyInput.value='';
  setStatus('已清除本地 API Key。');
});
recenterBtn.addEventListener('click', () => {
  if (origin) map.flyTo([origin.lat,origin.lon], 12, {duration:.6});
});
window.addEventListener('resize', () => setTimeout(() => map.invalidateSize(), 120));

if (!getKey()) setTimeout(() => setStatus('首次使用：定位地点后，请点右上角 ⚙ 设置 openrouteservice API Key。'), 300);
