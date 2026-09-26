const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const SEGMENT_MINUTES = 60;
const MAX_DURATION_MINUTES = 30 * 24 * 60;
const DISPLAY_CONTOURS = 4;
const PROFILE_SECTORS = 96;

// 前沿点数量由拟合边界长度决定，不再固定为 5。
// 约每 90 km 边界长度抽 1 个点，同时限制公共服务请求规模。
const FRONTIER_SPACING_KM = 90;
const MIN_FRONTIER_POINTS = 6;
const MAX_FRONTIER_POINTS = 24;
const REQUEST_CONCURRENCY = 2;
const REQUEST_DELAY_MS = 220;
const MAX_ENVELOPE_DISTANCE_KM = 9500;

const map = new maplibregl.Map({
  container:'map',
  style:MAP_STYLE,
  center:[108.5,34.5],
  zoom:4,
  minZoom:1.5,
  maxZoom:18,
  attributionControl:false
});

map.addControl(new maplibregl.NavigationControl({
  showCompass:false,
  visualizePitch:false
}),'top-right');

map.addControl(new maplibregl.AttributionControl({
  compact:true,
  customAttribution:'© OpenFreeMap · © OpenStreetMap contributors'
}),'bottom-right');

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

function setStatus(text,error=false){
  statusEl.textContent=text;
  statusEl.classList.toggle('error',error);
}

function setBusy(isBusy){
  generateBtn.disabled=isBusy || !origin;
  searchForm.querySelector('button').disabled=isBusy;
  locateBtn.disabled=isBusy;
  durationInput.disabled=isBusy;
  durationUnit.disabled=isBusy;
}

function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function waitForMapLoad(){
  if(map.loaded()) return Promise.resolve();
  return new Promise(resolve=>map.once('load',resolve));
}

function setOrigin(lat,lon,label){
  origin={lat:Number(lat),lon:Number(lon),label};

  if(originMarker) originMarker.remove();

  const el=document.createElement('div');
  el.className='origin-marker';
  el.innerHTML='<span></span>';

  originMarker=new maplibregl.Marker({
    element:el,
    anchor:'center'
  })
    .setLngLat([origin.lon,origin.lat])
    .setPopup(
      new maplibregl.Popup({
        offset:16,
        closeButton:false
      }).setHTML('<strong>起点</strong><br>'+escapeHtml(label))
    )
    .addTo(map);

  placeName.textContent=label;
  placeCard.classList.remove('hidden');
  recenterBtn.classList.remove('hidden');
  generateBtn.disabled=false;

  map.easeTo({
    center:[origin.lon,origin.lat],
    zoom:Math.max(map.getZoom(),11.5),
    duration:750
  });
}

function unitMultiplier(unit){
  if(unit==='day') return 1440;
  if(unit==='hour') return 60;
  return 1;
}

function formatDuration(minutes){
  if(minutes%1440===0) return (minutes/1440)+' 天';
  if(minutes>=1440) return (minutes/1440).toFixed(1).replace(/\.0$/,'')+' 天';
  if(minutes%60===0) return (minutes/60)+' 小时';
  if(minutes>=60) return (minutes/60).toFixed(1).replace(/\.0$/,'')+' 小时';
  return Math.round(minutes)+' 分钟';
}

function getDurationMinutes(){
  const raw=Number(durationInput.value);
  if(!Number.isFinite(raw) || raw<=0){
    throw new Error('请输入大于 0 的驾驶时长。');
  }

  const minutes=raw*unitMultiplier(durationUnit.value);
  if(minutes>MAX_DURATION_MINUTES){
    throw new Error('最大支持 30 天。');
  }
  if(minutes<4){
    throw new Error('为了稳定生成 4 个圈，最小时长请设为 4 分钟。');
  }
  return minutes;
}

function syncDurationControl(){
  const unit=durationUnit.value;

  if(unit==='day'){
    durationInput.max='30';
    durationInput.step='0.5';
  }else if(unit==='hour'){
    durationInput.max='720';
    durationInput.step='0.5';
  }else{
    durationInput.max=String(MAX_DURATION_MINUTES);
    durationInput.step='1';
  }

  let minutes=0;
  try{ minutes=getDurationMinutes(); }catch(_){}

  const multi=minutes>SEGMENT_MINUTES;

  durationModeLabel.textContent=
    multi ? '真实请求包络 · Demo' : '真实道路 · Valhalla';

  durationModeLabel.classList.toggle('estimate',multi);

  if(!minutes){
    durationHint.textContent='请输入驾驶时长。';
  }else if(multi){
    durationHint.textContent=
      '四个最终圈都会实际调用 Valhalla。拟合只负责预测目标圈前 60 分钟的前沿位置；前沿点数量按边界周长动态选取。';
  }else{
    durationHint.textContent=
      '四个圈均由起点直接调用真实 OSM 道路网络生成。';
  }
}

function colorForRatio(ratio){
  if(ratio<=0.25) return '#0b6f72';
  if(ratio<=0.50) return '#238b8e';
  if(ratio<=0.75) return '#58adb0';
  return '#9bd2d8';
}

function buildDisplayTimes(maxMinutes){
  const values=[];
  for(let i=1;i<=DISPLAY_CONTOURS;i++){
    values.push(Math.max(1,Math.round(maxMinutes*i/DISPLAY_CONTOURS)));
  }
  return [...new Set(values)];
}

function renderLegend(times){
  const max=Math.max(...times);
  legend.innerHTML=
    times.map(time=>(
      '<span class="legend-item">'+
        '<i class="legend-swatch" style="background:'+
        colorForRatio(time/max)+'"></i>'+
        formatDuration(time)+
      '</span>'
    )).join('')+
    '<span class="legend-mode">每个最终圈均包含真实 Valhalla 请求结果</span>';

  legend.classList.remove('hidden');
}

async function geocode(query){
  const cached=geocodeCache.get(query);
  if(cached) return cached;

  const url=
    NOMINATIM+
    '?format=jsonv2&limit=5&accept-language=zh-CN&q='+
    encodeURIComponent(query);

  const response=await fetch(url,{
    headers:{'Accept':'application/json'}
  });

  if(!response.ok){
    throw new Error('地点搜索服务暂时不可用（'+response.status+'）。');
  }

  const data=await response.json();
  geocodeCache.set(query,data);
  return data;
}

async function requestIsochrone(point,contours){
  const safe=
    [...new Set(contours)]
      .map(v=>Math.max(1,Math.min(SEGMENT_MINUTES,Math.round(v))))
      .sort((a,b)=>a-b)
      .slice(0,4);

  const payload={
    id:'sschizoo-service-envelope',
    locations:[{lat:point.lat,lon:point.lon}],
    costing:'auto',
    contours:safe.map((time,index)=>({
      time,
      color:colorForRatio((index+1)/safe.length).replace('#','')
    })),
    polygons:true,
    denoise:0.10,
    generalize:30
  };

  const url=
    VALHALLA_BASE+
    '/isochrone?json='+
    encodeURIComponent(JSON.stringify(payload));

  const response=await fetch(url,{
    headers:{'Accept':'application/json'}
  });

  let body=null;
  try{ body=await response.json(); }catch(_){}

  if(!response.ok){
    if(response.status===429){
      throw new Error('公共 Valhalla 请求过多，请稍后再试。');
    }

    const detail=
      body?.error ||
      body?.status ||
      ('HTTP '+response.status);

    throw new Error('真实道路等时圈生成失败：'+detail);
  }

  if(!body?.features?.length){
    throw new Error('该位置附近没有返回可用道路等时圈。');
  }

  return body;
}

function contourValue(feature){
  return Number(
    feature?.properties?.contour ??
    feature?.properties?.time ??
    0
  );
}

function featuresForContour(body,target){
  return (body.features||[]).filter(feature=>
    Math.abs(contourValue(feature)-target)<0.75 &&
    /Polygon/.test(feature.geometry?.type||'')
  );
}

function allPolygonFeatures(body){
  return (body.features||[]).filter(feature=>
    /Polygon/.test(feature.geometry?.type||'')
  );
}

function inverseGeodesic(lat1,lon1,lat2,lon2){
  const R=6371.0088;
  const p1=lat1*Math.PI/180;
  const p2=lat2*Math.PI/180;
  const dp=(lat2-lat1)*Math.PI/180;
  const dl=(lon2-lon1)*Math.PI/180;

  const a=
    Math.sin(dp/2)**2+
    Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;

  const c=
    2*Math.atan2(
      Math.sqrt(a),
      Math.sqrt(Math.max(0,1-a))
    );

  const y=Math.sin(dl)*Math.cos(p2);
  const x=
    Math.cos(p1)*Math.sin(p2)-
    Math.sin(p1)*Math.cos(p2)*Math.cos(dl);

  return {
    distanceKm:R*c,
    bearing:(Math.atan2(y,x)*180/Math.PI+360)%360
  };
}

function destinationPoint(lat,lon,bearingDeg,distanceKm){
  const R=6371.0088;
  const delta=Math.min(distanceKm,MAX_ENVELOPE_DISTANCE_KM)/R;
  const theta=bearingDeg*Math.PI/180;
  const phi1=lat*Math.PI/180;
  const lambda1=lon*Math.PI/180;

  const sinPhi2=
    Math.sin(phi1)*Math.cos(delta)+
    Math.cos(phi1)*Math.sin(delta)*Math.cos(theta);

  const phi2=
    Math.asin(Math.max(-1,Math.min(1,sinPhi2)));

  const y=
    Math.sin(theta)*Math.sin(delta)*Math.cos(phi1);

  const x=
    Math.cos(delta)-Math.sin(phi1)*Math.sin(phi2);

  let lambda2=lambda1+Math.atan2(y,x);
  lambda2=((lambda2+3*Math.PI)%(2*Math.PI))-Math.PI;

  return [
    lambda2*180/Math.PI,
    phi2*180/Math.PI
  ];
}

function geometryRings(feature){
  const geometry=feature?.geometry;
  if(!geometry) return [];

  if(geometry.type==='Polygon'){
    return geometry.coordinates?.length
      ? [geometry.coordinates[0]]
      : [];
  }

  if(geometry.type==='MultiPolygon'){
    return geometry.coordinates
      .map(poly=>poly?.[0]||[])
      .filter(ring=>ring.length);
  }

  return [];
}

function radialProfileFromFeatures(features,sectors=PROFILE_SECTORS){
  const radii=new Array(sectors).fill(0);

  for(const feature of features){
    for(const ring of geometryRings(feature)){
      for(const coord of ring){
        const lon=Number(coord[0]);
        const lat=Number(coord[1]);
        if(!Number.isFinite(lon)||!Number.isFinite(lat)) continue;

        const inv=
          inverseGeodesic(
            origin.lat,
            origin.lon,
            lat,
            lon
          );

        const idx=
          Math.floor((inv.bearing/360)*sectors)%sectors;

        if(inv.distanceKm>radii[idx]){
          radii[idx]=inv.distanceKm;
        }
      }
    }
  }

  fillCircularGaps(radii);
  return smoothCircular(radii,1);
}

function fillCircularGaps(values){
  const n=values.length;
  const nonzero=values
    .map((value,index)=>value>0?index:-1)
    .filter(index=>index>=0);

  if(!nonzero.length) return values;

  if(nonzero.length===1){
    values.fill(values[nonzero[0]]);
    return values;
  }

  for(let i=0;i<n;i++){
    if(values[i]>0) continue;

    let left=i;
    let guard=0;
    while(values[left]===0 && guard<n){
      left=(left-1+n)%n;
      guard++;
    }

    let right=i;
    guard=0;
    while(values[right]===0 && guard<n){
      right=(right+1)%n;
      guard++;
    }

    const lv=values[left]||0;
    const rv=values[right]||0;

    values[i]=
      lv>0 && rv>0
        ? (lv+rv)/2
        : Math.max(lv,rv);
  }

  return values;
}

function smoothCircular(values,radius){
  const n=values.length;
  const out=new Array(n).fill(0);

  for(let i=0;i<n;i++){
    let sum=0;
    let weightSum=0;

    for(let d=-radius;d<=radius;d++){
      const idx=(i+d+n)%n;
      const weight=radius+1-Math.abs(d);
      sum+=values[idx]*weight;
      weightSum+=weight;
    }

    out[i]=sum/weightSum;
  }

  return out;
}

function polygonFromProfile(profile,time,serviceDerived){
  const ring=[];

  for(let i=0;i<profile.length;i++){
    const bearing=(i+0.5)*360/profile.length;

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
      serviceDerived:Boolean(serviceDerived)
    },
    geometry:{
      type:'Polygon',
      coordinates:[ring]
    }
  };
}

function profileAtTime(observations,targetTime){
  const sorted=
    [...observations].sort((a,b)=>a.time-b.time);

  const exact=
    sorted.find(obs=>Math.abs(obs.time-targetTime)<0.5);

  if(exact) return exact.profile;

  const before=
    [...sorted].reverse().find(obs=>obs.time<targetTime);

  const after=
    sorted.find(obs=>obs.time>targetTime);

  if(before&&after){
    const ratio=
      (targetTime-before.time)/(after.time-before.time);

    return smoothCircular(
      before.profile.map((value,index)=>
        value+(after.profile[index]-value)*ratio
      ),
      1
    );
  }

  if(!before&&after){
    const scale=Math.max(0.05,targetTime/after.time);
    return after.profile.map(value=>value*scale);
  }

  const recent=
    sorted.filter(obs=>obs.time>=15).slice(-5);

  const fitted=new Array(PROFILE_SECTORS);

  for(let sector=0;sector<PROFILE_SECTORS;sector++){
    const usable=
      recent.filter(obs=>obs.profile[sector]>0.1);

    if(!usable.length){
      fitted[sector]=0;
      continue;
    }

    if(usable.length===1){
      const only=usable[0];
      fitted[sector]=
        only.profile[sector]*
        Math.pow(targetTime/only.time,0.70);
      continue;
    }

    const xs=usable.map(obs=>Math.log(obs.time));
    const ys=usable.map(obs=>Math.log(obs.profile[sector]));

    const xMean=xs.reduce((a,b)=>a+b,0)/xs.length;
    const yMean=ys.reduce((a,b)=>a+b,0)/ys.length;

    let numerator=0;
    let denominator=0;

    for(let i=0;i<xs.length;i++){
      numerator+=(xs[i]-xMean)*(ys[i]-yMean);
      denominator+=(xs[i]-xMean)**2;
    }

    let exponent=
      denominator>1e-9
        ? numerator/denominator
        : 0.70;

    exponent=Math.max(0.20,Math.min(1.05,exponent));

    const intercept=yMean-exponent*xMean;
    const prediction=
      Math.exp(intercept)*Math.pow(targetTime,exponent);

    const last=usable[usable.length-1].profile[sector];

    fitted[sector]=Math.min(
      MAX_ENVELOPE_DISTANCE_KM,
      Math.max(last,prediction)
    );
  }

  return smoothCircular(fitted,2);
}

function ringForSampling(feature){
  const rings=geometryRings(feature);
  if(!rings.length) return null;

  let best=rings[0];
  let bestLength=0;

  for(const ring of rings){
    try{
      const line=turf.lineString(ring);
      const length=turf.length(line,{units:'kilometers'});
      if(length>bestLength){
        best=ring;
        bestLength=length;
      }
    }catch(_){}
  }

  return best?.length ? best : null;
}

function frontierCountFromPerimeter(perimeterKm){
  return Math.max(
    MIN_FRONTIER_POINTS,
    Math.min(
      MAX_FRONTIER_POINTS,
      Math.ceil(perimeterKm/FRONTIER_SPACING_KM)
    )
  );
}

function sampleFrontierByLength(feature){
  const ring=ringForSampling(feature);
  if(!ring) return {points:[],perimeterKm:0,count:0};

  const line=turf.lineString(ring);
  const perimeterKm=turf.length(line,{units:'kilometers'});
  const count=frontierCountFromPerimeter(perimeterKm);

  const points=[];

  for(let i=0;i<count;i++){
    const distance=
      perimeterKm*(i+0.5)/count;

    const point=
      turf.along(
        line,
        distance,
        {units:'kilometers'}
      );

    const coord=point.geometry.coordinates;

    points.push({
      lon:Number(coord[0]),
      lat:Number(coord[1])
    });
  }

  return {
    points,
    perimeterKm,
    count
  };
}

async function mapWithConcurrency(items,limit,worker){
  const results=new Array(items.length);
  let cursor=0;

  async function runner(workerId){
    while(true){
      const index=cursor++;
      if(index>=items.length) return;

      if(index>0){
        await new Promise(resolve=>
          setTimeout(
            resolve,
            REQUEST_DELAY_MS+workerId*90
          )
        );
      }

      results[index]=
        await worker(items[index],index);
    }
  }

  const workers=[];
  for(let i=0;i<Math.min(limit,items.length);i++){
    workers.push(runner(i));
  }

  await Promise.all(workers);
  return results;
}

function addObservation(observations,time,feature){
  observations.push({
    time,
    profile:radialProfileFromFeatures([feature])
  });
}

async function buildServiceDerivedContours(maxMinutes){
  const displayTimes=buildDisplayTimes(maxMinutes);
  const outputFeatures=[];
  const observations=[];
  const cumulativeServiceFeatures=[];

  const exactDisplayTimes=
    displayTimes.filter(time=>time<=SEGMENT_MINUTES);

  // 一次请求可以直接生成最多 4 个 <=60 分钟的最终圈。
  const calibrationContours=
    [...new Set([
      15,30,45,60,
      ...exactDisplayTimes
    ])]
      .filter(time=>time<=60)
      .sort((a,b)=>a-b);

  // 服务最多 4 条 contour。若最终圈本身需要精确值，则优先保留；
  // 其他时间另发一个小请求补齐校准样本。
  const primaryContours=
    [...new Set([
      ...exactDisplayTimes,
      60
    ])]
      .sort((a,b)=>a-b)
      .slice(0,4);

  const primaryBody=
    await requestIsochrone(origin,primaryContours);

  const primaryFeatures=
    allPolygonFeatures(primaryBody);

  cumulativeServiceFeatures.push(...primaryFeatures);

  for(const time of primaryContours){
    const matches=featuresForContour(primaryBody,time);
    if(matches.length){
      const profile=
        radialProfileFromFeatures(matches);

      observations.push({time,profile});

      if(displayTimes.includes(time)){
        outputFeatures.push(
          polygonFromProfile(profile,time,true)
        );
      }
    }
  }

  const missingCalibration=
    [15,30,45,60].filter(time=>
      !observations.some(obs=>Math.abs(obs.time-time)<0.5)
    );

  if(missingCalibration.length){
    const body=
      await requestIsochrone(
        origin,
        missingCalibration.slice(0,4)
      );

    const features=allPolygonFeatures(body);
    cumulativeServiceFeatures.push(...features);

    for(const time of missingCalibration.slice(0,4)){
      const matches=featuresForContour(body,time);
      if(matches.length){
        observations.push({
          time,
          profile:radialProfileFromFeatures(matches)
        });
      }
    }
  }

  const longTargets=
    displayTimes.filter(time=>time>SEGMENT_MINUTES);

  for(let targetIndex=0;targetIndex<longTargets.length;targetIndex++){
    const targetTime=longTargets[targetIndex];

    const preTime=
      Math.max(1,targetTime-SEGMENT_MINUTES);

    const preProfile=
      profileAtTime(
        observations,
        preTime
      );

    const predictedFrontier=
      polygonFromProfile(
        preProfile,
        preTime,
        false
      );

    const sampling=
      sampleFrontierByLength(predictedFrontier);

    if(!sampling.points.length){
      throw new Error(
        '无法从拟合前沿提取采样点。'
      );
    }

    setStatus(
      '生成第 '+(targetIndex+1)+' 个长时程最终圈：'+
      '拟合前沿周长约 '+
      Math.round(sampling.perimeterKm)+
      ' km，按长度选取 '+
      sampling.count+
      ' 个前沿点，每个点调用真实 60 分钟 Valhalla…'
    );

    const responses=
      await mapWithConcurrency(
        sampling.points,
        REQUEST_CONCURRENCY,
        point=>requestIsochrone(
          point,
          [SEGMENT_MINUTES]
        )
      );

    const freshServiceFeatures=
      responses.flatMap(body=>
        featuresForContour(
          body,
          SEGMENT_MINUTES
        )
      );

    if(!freshServiceFeatures.length){
      throw new Error(
        '前沿点请求没有返回有效的 60 分钟道路边界。'
      );
    }

    cumulativeServiceFeatures.push(
      ...freshServiceFeatures
    );

    // 最终圈只使用真实服务返回边界做外包络；
    // 拟合边界不进入最终结果。
    const finalProfile=
      radialProfileFromFeatures(
        cumulativeServiceFeatures
      );

    const finalFeature=
      polygonFromProfile(
        finalProfile,
        targetTime,
        true
      );

    outputFeatures.push(finalFeature);
    observations.push({
      time:targetTime,
      profile:finalProfile
    });
  }

  // 若某个 <=60 最终时刻没有在 primary 请求中（极少数重复/切片情况），
  // 单独真实请求它，确保四个最终圈都经过服务。
  for(const time of displayTimes){
    if(
      !outputFeatures.some(feature=>
        Math.abs(Number(feature.properties?.contour)-time)<0.5
      )
    ){
      if(time<=60){
        const body=
          await requestIsochrone(origin,[time]);

        const matches=
          featuresForContour(body,time);

        if(matches.length){
          const profile=
            radialProfileFromFeatures(matches);

          outputFeatures.push(
            polygonFromProfile(
              profile,
              time,
              true
            )
          );

          observations.push({time,profile});
          cumulativeServiceFeatures.push(...matches);
        }
      }
    }
  }

  outputFeatures.sort(
    (a,b)=>
      Number(a.properties.contour)-
      Number(b.properties.contour)
  );

  return {
    displayTimes,
    features:outputFeatures
  };
}

function clearIsochroneLayers(){
  for(const id of contourLayerIds){
    if(map.getLayer(id)) map.removeLayer(id);
  }
  contourLayerIds=[];

  if(map.getSource('isochrones')){
    map.removeSource('isochrones');
  }
}

function findFirstSymbolLayer(){
  const layers=map.getStyle()?.layers||[];
  return layers.find(layer=>layer.type==='symbol')?.id;
}

function extendBoundsFromCoordinates(coords,bounds){
  if(!Array.isArray(coords)) return;

  if(
    coords.length>=2 &&
    typeof coords[0]==='number' &&
    typeof coords[1]==='number'
  ){
    bounds.extend([coords[0],coords[1]]);
    return;
  }

  for(const item of coords){
    extendBoundsFromCoordinates(item,bounds);
  }
}

function fitGeoJSON(features){
  const bounds=new maplibregl.LngLatBounds();

  for(const feature of features){
    extendBoundsFromCoordinates(
      feature.geometry?.coordinates,
      bounds
    );
  }

  if(!bounds.isEmpty()){
    map.fitBounds(bounds,{
      padding:{
        top:70,
        right:70,
        bottom:70,
        left:window.innerWidth<=760?70:430
      },
      duration:900,
      maxZoom:11
    });
  }
}

async function drawResult(result){
  await waitForMapLoad();
  clearIsochroneLayers();

  const features=
    [...result.features].sort(
      (a,b)=>
        Number(b.properties?.contour||0)-
        Number(a.properties?.contour||0)
    );

  map.addSource('isochrones',{
    type:'geojson',
    data:{
      type:'FeatureCollection',
      features
    }
  });

  const beforeId=findFirstSymbolLayer();
  const max=Math.max(...result.displayTimes);

  [...result.displayTimes]
    .sort((a,b)=>b-a)
    .forEach((time,index)=>{
      const fillId='iso-fill-'+index;
      const lineId='iso-line-'+index;
      const color=colorForRatio(time/max);

      const filter=[
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
          'fill-opacity':0.16
        }
      },beforeId);

      map.addLayer({
        id:lineId,
        type:'line',
        source:'isochrones',
        filter,
        paint:{
          'line-color':color,
          'line-width':1.8,
          'line-opacity':0.95
        }
      },beforeId);

      contourLayerIds.push(fillId,lineId);
    });

  fitGeoJSON(features);
}

searchForm.addEventListener('submit',async event=>{
  event.preventDefault();

  const query=placeInput.value.trim();
  if(!query) return;

  setBusy(true);
  setStatus('正在查找地点…');

  try{
    const data=await geocode(query);

    if(!data.length){
      throw new Error('没有找到这个地点，请尝试更具体的名称。');
    }

    const best=data[0];

    setOrigin(
      best.lat,
      best.lon,
      best.display_name||query
    );

    setStatus('地点已定位。输入驾驶时长后即可生成 4 个等时圈。');
  }catch(error){
    setStatus(error.message||'地点查找失败。',true);
  }finally{
    setBusy(false);
  }
});

locateBtn.addEventListener('click',()=>{
  if(!navigator.geolocation){
    setStatus('当前浏览器不支持定位。',true);
    return;
  }

  setStatus('正在获取设备位置…');
  locateBtn.disabled=true;

  navigator.geolocation.getCurrentPosition(
    position=>{
      setOrigin(
        position.coords.latitude,
        position.coords.longitude,
        '设备当前位置'
      );
      setStatus('已获取当前位置。');
      locateBtn.disabled=false;
    },
    error=>{
      const message=
        error.code===1
          ? '定位权限被拒绝，请在浏览器设置中允许定位。'
          : '无法获取当前位置，请改为输入地点。';

      setStatus(message,true);
      locateBtn.disabled=false;
    },
    {
      enableHighAccuracy:true,
      timeout:10000,
      maximumAge:60000
    }
  );
});

durationInput.addEventListener('input',syncDurationControl);

durationUnit.addEventListener('change',()=>{
  const value=Number(durationInput.value);

  if(durationUnit.value==='day'&&value>30){
    durationInput.value='30';
  }

  if(durationUnit.value==='hour'&&value>720){
    durationInput.value='720';
  }

  syncDurationControl();
});

generateBtn.addEventListener('click',async()=>{
  if(!origin){
    setStatus('请先选择起点。',true);
    return;
  }

  let maxMinutes;
  try{
    maxMinutes=getDurationMinutes();
  }catch(error){
    setStatus(error.message,true);
    return;
  }

  setBusy(true);

  try{
    setStatus(
      maxMinutes<=60
        ? '正在直接调用 Valhalla 生成 4 个真实最终圈…'
        : '正在生成 4 个最终圈；长时程圈会根据边界长度动态抽取前沿点并逐点调用真实 Valhalla…'
    );

    const result=
      await buildServiceDerivedContours(
        maxMinutes
      );

    if(result.features.length!==result.displayTimes.length){
      throw new Error(
        '最终圈数量不足：预期 '+
        result.displayTimes.length+
        ' 个，实际 '+
        result.features.length+
        ' 个。'
      );
    }

    await drawResult(result);
    renderLegend(result.displayTimes);

    setStatus(
      '已生成 '+result.displayTimes.length+
      ' 个最终圈。每个最终圈都包含真实 Valhalla 服务计算；拟合只用于前沿点定位。'
    );
  }catch(error){
    console.error(error);
    setStatus(
      error.message||
      '等时圈生成失败，请稍后重试。',
      true
    );
  }finally{
    setBusy(false);
    syncDurationControl();
  }
});

recenterBtn.addEventListener('click',()=>{
  if(!origin) return;

  map.easeTo({
    center:[origin.lon,origin.lat],
    zoom:11.5,
    duration:650
  });
});

map.on('error',event=>{
  const message=String(event?.error?.message||'');

  if(/401|403|api key|token/i.test(message)){
    setStatus('底图服务响应异常，请刷新页面重试。',true);
  }
});

syncDurationControl();
