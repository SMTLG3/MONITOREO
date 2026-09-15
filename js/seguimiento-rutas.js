/* V91 — SEGUIMIENTO DE RUTAS PROGRAMADAS
   Este módulo NO crea ni edita rutas.
   Solo muestra viajes activos que tienen una ruta trazada asignada,
   sigue su posición Samsara y deja la creación/configuración en RUTAS TRAZADAS.
*/
(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const ORANGE='#FF8A00', BLUE='#1677FF';
  const POLL_MS=10000;
  let modal=null,map=null,street=null,satellite=null,transport=null,labels=null;
  let routeLayer=null, markerLayer=null, selectedId=null, timer=null,busy=false;
  let rows=[];

  document.addEventListener('DOMContentLoaded', init);
  function init(){
    modal=$('modalSeguimientoRutas');
    $('btnAbrirSeguimientoRutas')?.addEventListener('click',open);
    $('cerrarSeguimientoRutas')?.addEventListener('click',close);
    $('btnVolverAlertasDesdeSeguimiento')?.addEventListener('click',()=>{close();window.SMTAlertasGPS?.open?.();});
    $('btnAbrirGestionRutasDesdeSeguimiento')?.addEventListener('click',()=>{close();window.SMTRutaPlanner?.open?.();});
    modal?.addEventListener('click',e=>{if(e.target===modal)close();});

    timer=setInterval(()=>refresh(false),POLL_MS);
    setTimeout(()=>refresh(false),1200);
  }
  function isVisible(el){return !!el&&getComputedStyle(el).display!=='none'&&el.getAttribute('aria-hidden')!=='true';}
  function norm(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();}
  function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}
  function routeKey(o,d,m){const a=norm(o),b=norm(d),c=norm(m);return a&&b?`${a}__${b}__${c}`:'';}
  function setStatus(t){const e=$('seguimientoRutasEstado');if(e)e.textContent=t;}
  function open(){if(!modal)return;modal.style.display='flex';modal.setAttribute('aria-hidden','false');initMap();setTimeout(()=>map?.invalidateSize(true),80);refresh(true);}
  function close(){if(modal){modal.style.display='none';modal.setAttribute('aria-hidden','true');}}

  function initMap(){
    if(map||!window.L)return;
    map=L.map('seguimientoRutasMap',{minZoom:3,maxZoom:19,zoomControl:true,attributionControl:true}).setView([23.6345,-102.5528],5);
    street=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,maxNativeZoom:19,attribution:'Mapa © Esri'});
    satellite=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,maxNativeZoom:18,attribution:'Imagen © Esri'});
    transport=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,maxNativeZoom:18,attribution:'Transporte © Esri'});
    labels=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,maxNativeZoom:18,attribution:'Lugares © Esri'});
    applyBase();
    routeLayer=L.layerGroup().addTo(map); markerLayer=L.layerGroup().addTo(map);
    const ctrl=L.control({position:'topright'});
    ctrl.onAdd=()=>{const b=L.DomUtil.create('button','ruta-basemap-toggle');b.type='button';b.title='Cambiar vista de mapa';L.DomEvent.disableClickPropagation(b);L.DomEvent.on(b,'click',()=>{const cur=localStorage.getItem('SMT_SAMSARA_MAP_VIEW')==='normal'?'normal':'hybrid';localStorage.setItem('SMT_SAMSARA_MAP_VIEW',cur==='hybrid'?'normal':'hybrid');applyBase();});return b;};ctrl.addTo(map);
  }
  function applyBase(){if(!map)return;[street,satellite,transport,labels].forEach(x=>x&&map.hasLayer(x)&&map.removeLayer(x));let hybrid=true;try{hybrid=localStorage.getItem('SMT_SAMSARA_MAP_VIEW')!=='normal';}catch(_){};if(hybrid){satellite.addTo(map);transport.addTo(map);labels.addTo(map);}else street.addTo(map);}

  async function loadActiveTrips(){
    if(!window.supabaseClient)return [];
    const {data,error}=await window.supabaseClient.from('viajes').select('id,id_viaje,eco,origen,destino,municipio,estatus,fecha,hora_salida').in('estatus',['EN PROYECTO','EN RUTA','EN RESGUARDO','PARADA PARA COMER']).order('fecha',{ascending:false}).order('hora_salida',{ascending:false});
    if(error)throw error;
    return data||[];
  }
  async function routeForTrip(trip){
    if(!window.supabaseClient)return null;
    try{
      const r=await window.supabaseClient.from('viaje_ruta_trazos').select('*').eq('id_viaje',String(trip.id_viaje)).maybeSingle();
      if(!r.error&&r.data?.geometria){
        let linked=r.data;
        // La asignación del viaje es la fuente de la geometría; si no trae
        // etiquetas, recuperamos las etiquetas de la ruta maestra por su clave.
        if((!linked.origen||!linked.destino) && linked.clave){
          try{
            const rr=await window.supabaseClient.from('rutas_trazadas').select('origen,destino,municipio,tipo,distancia_km').eq('clave',linked.clave).maybeSingle();
            if(!rr.error&&rr.data) linked={...rr.data,...linked};
          }catch(_){}
        }
        return linked;
      }
    }catch(_){}
    const key=routeKey(trip.origen,trip.destino,trip.municipio);
    if(!key)return null;
    try{const r=await window.supabaseClient.from('rutas_trazadas').select('*').eq('clave',key).maybeSingle();if(!r.error&&r.data?.geometria)return r.data;}catch(_){}
    return null;
  }
  async function getLinkedUnit(eco){
    if(!window.supabaseClient)return null;
    try{const r=await window.supabaseClient.from('unidades').select('id,eco,samsara_vehicle_id').eq('eco',eco).maybeSingle();return r.data||null;}catch(_){return null;}
  }
  function geometryToLatLngs(g){if(!g)return[];if(g.type==='Feature'&&g.geometry)return geometryToLatLngs(g.geometry);if(g.type==='LineString'&&Array.isArray(g.coordinates))return g.coordinates.map(p=>[Number(p[1]),Number(p[0])]).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1]));return[];}
  function drawAll(){
    routeLayer?.clearLayers();markerLayer?.clearLayers();
    const bounds=[];
    rows.forEach(row=>{
      const pts=geometryToLatLngs(row.route?.geometria);if(pts.length<2)return;
      const active=row.id===selectedId;
      const line=L.polyline(pts,{color:ORANGE,weight:active?8:5,opacity:active?1:.45,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);
      line.bindTooltip(`${esc(row.eco)} · ${esc(row.origen)} → ${esc(row.destino)}`);
      pts.forEach(p=>bounds.push(p));
      if(row.gps){const p=[row.gps.latitude,row.gps.longitude];const marker=L.circleMarker(p,{radius:active?8:6,color:BLUE,weight:3,fillColor:'#fff',fillOpacity:1}).addTo(markerLayer);marker.bindTooltip(`${esc(row.eco)} · ${esc(row.gps.location||'GPS')}`);bounds.push(p);}
    });
    if(selectedId){const selected=rows.find(r=>r.id===selectedId);const pts=geometryToLatLngs(selected?.route?.geometria);if(pts.length>1){try{map.fitBounds(L.latLngBounds(pts),{padding:[40,40],maxZoom:13});}catch(_){}}}
    else if(bounds.length>1){try{map.fitBounds(L.latLngBounds(bounds),{padding:[35,35],maxZoom:10});}catch(_){} }
  }
  function renderList(){
    const box=$('listaSeguimientoRutas');if(!box)return;
    if(!rows.length){box.innerHTML='<div class="seguimiento-empty"><span>✓</span><strong>NO HAY UNIDADES CON RUTA PROGRAMADA</strong><small>Las unidades aparecen aquí cuando el viaje activo tiene una ruta trazada asignada.</small></div>';return;}
    box.innerHTML=rows.map(r=>{
      const deviation=r.deviation;
      const stopped=r.stopped;
      const gps=r.gps;
      const tripStatus=norm(r.trip?.estatus);
      const state=deviation?.active?'DESVÍO':(tripStatus==='EN RESGUARDO'?'EN RESGUARDO':tripStatus==='PARADA PARA COMER'?'PARADA PARA COMER':stopped?.active?'DETENIDA':'EN RUTA');
      const cls=deviation?.active?'is-alert':stopped?.active?'is-stopped':'is-ok';
      const dist=deviation?.distance ? ` · ${Math.round(deviation.distance)} M` : '';
      return `<button type="button" class="seguimiento-ruta-card ${cls} ${r.id===selectedId?'is-selected':''}" data-id="${esc(r.id)}"><div class="seguimiento-ruta-card-top"><strong>${esc(r.eco||r.trip?.eco||'ECO')}</strong><span>${state}</span></div><div class="seguimiento-ruta-route">${esc(r.origen||'SIN ORIGEN')} → ${esc(r.destino||'SIN DESTINO')}</div><small>${esc(r.municipio||'SIN MUNICIPIO')} · ${gps?esc(gps.location||'GPS ACTIVO'):'SIN GPS'}${dist}</small></button>`;
    }).join('');
    box.querySelectorAll('[data-id]').forEach(b=>b.addEventListener('click',()=>{selectedId=b.dataset.id;renderList();drawAll();}));
  }
  async function refresh(force){
    if(busy)return;busy=true;
    try{
      const trips=await loadActiveTrips();
      const out=[];
      for(const trip of trips){
        const route=await routeForTrip(trip);if(!route)continue;
        const eco=String(trip.eco||'').trim();
        const unit=await getLinkedUnit(eco);if(!unit?.samsara_vehicle_id)continue;
        const displayOrigin=route.origen||trip.origen||'';
        const displayDestination=route.destino||trip.destino||'';
        const displayMunicipio=route.municipio??trip.municipio??'';
        out.push({id:String(trip.id_viaje),trip,route,unit,eco:unit.eco||eco,origen:displayOrigin,destino:displayDestination,municipio:displayMunicipio,gps:null,deviation:null,stopped:null});
      }
      const snap=out.length?await window.SamsaraUI?.getGpsSnapshot?.(out.map(r=>r.unit.samsara_vehicle_id)):null;
      for(const r of out){if(snap){const g=snap.get(String(r.unit.samsara_vehicle_id));if(g&&Number.isFinite(Number(g.latitude))&&Number.isFinite(Number(g.longitude)))r.gps={...g,latitude:Number(g.latitude),longitude:Number(g.longitude)};}}
      for(const r of out){
        const st=window.SMTAlertasGPS?.getOperationalState?.(r.eco);
        if(st){r.deviation=st.deviation||null;r.stopped=st.stopped||null;}
      }
      rows=out;
      if(!selectedId||!rows.some(r=>r.id===selectedId))selectedId=rows[0]?.id||null;
      renderList();drawAll();
      setStatus(`${rows.length} UNIDAD${rows.length===1?'':'ES'} · SEGUIMIENTO ACTIVO`);
    }catch(e){console.warn('Seguimiento de rutas:',e);setStatus('NO SE PUDO ACTUALIZAR EL SEGUIMIENTO');}
    finally{busy=false;}
  }
  window.SMTSeguimientoRutas={open,close,refresh};
})();
