/* V98 — ALERTAS Y ESTATUS OPERATIVO AUTOMÁTICO
   - DESVÍO: 2 lecturas consecutivas a más de 1 km del trazado.
   - DETENIDA: velocidad <= 2 mph durante 10 minutos.
   - Dentro de cualquier geocerca activa: una detención NO genera alerta DETENIDA.
   - Desde las 22:00, 10 minutos detenida dentro de una geocerca => EN RESGUARDO.
   - Si vuelve a moverse (> 2 mph), cualquier estatus activo => EN RUTA.
*/
(function(){
  'use strict';
  const TABLE='ruta_alertas_operativas';
  const LOCAL='SMT_RUTA_ALERTAS_V98';
  const STATE='SMT_RUTA_ESTADO_V99';
  const DEVIATION_M=1000, DEVIATION_CONFIRM=2, DEVIATION_COOLDOWN=10*60*1000;
  const STOP_SPEED_MPH=2, STOP_AFTER=10*60*1000, STOP_COOLDOWN=20*60*1000;
  const RESGUARDO_HOUR=22, POLL=15000, GEOFENCE_CACHE_MS=60000;
  const ACTIVE_STATUSES=['EN PROYECTO','EN RUTA','EN RESGUARDO','PARADA PARA COMER'];
  const $=id=>document.getElementById(id);
  let modal=null,timer=null,busy=false,units=[],alerts=[],routeCache=new Map();
  let geofences=[],geofencesLoadedAt=0,state=loadJson(STATE,{});

  document.addEventListener('DOMContentLoaded',init);
  function init(){
    modal=$('modalAlertasGps');
    $('btnAbrirAlertasGps')?.addEventListener('click',open);
    $('cerrarAlertasGps')?.addEventListener('click',close);
    $('btnAbrirSeguimientoDesdeAlertas')?.addEventListener('click',()=>{close();window.SMTSeguimientoRutas?.open?.();});
    loadPersistedAlerts();
    setTimeout(refreshCatalog,1200);
    timer=setInterval(poll,POLL); poll();
  }
  function loadJson(key,fallback){try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback))||fallback;}catch(_){return fallback;}}
  function saveJson(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(_){} }
  function norm(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();}
  function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}
  function routeDistance(point,line){let best=Infinity;for(let i=1;i<line.length;i++){const a=line[i-1],b=line[i],lat=point[0]*Math.PI/180,kx=Math.cos(lat)*111320,ky=110540,ax=a[1]*kx,ay=a[0]*ky,bx=b[1]*kx,by=b[0]*ky,px=point[1]*kx,py=point[0]*ky,dx=bx-ax,dy=by-ay,len=dx*dx+dy*dy,t=len?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/len)):0;best=Math.min(best,Math.hypot(px-(ax+t*dx),py-(ay+t*dy)));}return best;}
  function distanceMeters(a,b){const R=6371000,p=Math.PI/180,dLat=(b[0]-a[0])*p,dLng=(b[1]-a[1])*p,q=Math.sin(dLat/2)**2+Math.cos(a[0]*p)*Math.cos(b[0]*p)*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(q)));}
  function geometry(g){if(!g)return[];if(g.type==='Feature'&&g.geometry)return geometry(g.geometry);if(g.type==='LineString'&&Array.isArray(g.coordinates))return g.coordinates.map(p=>[Number(p[1]),Number(p[0])]).filter(p=>p.every(Number.isFinite));return[];}
  function routeKey(o,d,m){const a=norm(o),b=norm(d),c=norm(m);return a&&b?`${a}__${b}__${c}`:'';}
  function isAfterResguardoHour(){return new Date().getHours()>=RESGUARDO_HOUR;}

  async function refreshCatalog(){
    try{const r=await window.supabaseClient.from('unidades').select('id,eco,samsara_vehicle_id').eq('activo',true).order('eco',{ascending:true});if(r.error)throw r.error;units=r.data||[];render();}catch(e){console.warn('Alertas catálogo:',e);}
  }
  async function activeTrips(){
    const r=await window.supabaseClient.from('viajes').select('id,id_viaje,eco,origen,destino,municipio,estatus,fecha,hora_salida').in('estatus',ACTIVE_STATUSES).order('fecha',{ascending:false}).order('hora_salida',{ascending:false});
    if(r.error)throw r.error;return r.data||[];
  }
  async function loadGeofences(force=false){
    if(!force&&geofencesLoadedAt&&Date.now()-geofencesLoadedAt<GEOFENCE_CACHE_MS)return geofences;
    try{
      const r=await window.supabaseClient.from('monitoreo_geocercas').select('id,nombre,lat,lng,radio_metros,activo,tipo_geocerca').eq('activo',true);
      if(r.error)throw r.error;
      geofences=(r.data||[]).map(g=>({id:g.id,nombre:g.nombre||'GEOCERCA',lat:Number(g.lat),lng:Number(g.lng),radio:Number(g.radio_metros||300)})).filter(g=>Number.isFinite(g.lat)&&Number.isFinite(g.lng)&&g.radio>0);
    }catch(e){console.warn('Geocercas para automatización:',e);geofences=[];}
    geofencesLoadedAt=Date.now();return geofences;
  }
  function findGeofence(point){let found=null,best=Infinity;for(const g of geofences){const d=distanceMeters(point,[g.lat,g.lng]);if(d<=g.radio&&d<best){best=d;found={...g,distancia:d};}}return found;}
  async function routeForTrip(t){
    const id=String(t.id_viaje||'');
    if(id){try{const r=await window.supabaseClient.from('viaje_ruta_trazos').select('*').eq('id_viaje',id).maybeSingle();if(!r.error&&r.data?.geometria)return r.data;}catch(_) {}}
    const key=routeKey(t.origen,t.destino,t.municipio);if(!key)return null;if(routeCache.has(key))return routeCache.get(key);
    try{const r=await window.supabaseClient.from('rutas_trazadas').select('*').eq('clave',key).maybeSingle();const row=!r.error?r.data:null;routeCache.set(key,row||null);return row||null;}catch(_){routeCache.set(key,null);return null;}
  }
  function unitForEco(eco){return units.find(u=>norm(u.eco)===norm(eco))||null;}
  function activeAlert(eco,type){return alerts.find(a=>a.eco===eco&&a.tipo===type&&a.estado==='ACTIVA');}
  function incidentKey(eco,type){return `ACK|${norm(eco)}|${type}`;}
  function incidentAcknowledged(eco,type){return Boolean(state[incidentKey(eco,type)]?.at);}
  function clearIncidentAcknowledgement(eco,type){delete state[incidentKey(eco,type)];}

  async function updateTripStatus(trip,newStatus,reason){
    const current=norm(trip?.estatus);
    if(!trip?.id_viaje||!ACTIVE_STATUSES.includes(newStatus)||current===newStatus)return false;
    try{
      const r=await window.supabaseClient.from('viajes').update({estatus:newStatus}).eq('id_viaje',String(trip.id_viaje));
      if(r.error)throw r.error;
      trip.estatus=newStatus;
      window.dispatchEvent(new CustomEvent('smt:estatus-automatico',{detail:{id_viaje:String(trip.id_viaje),eco:trip.eco,estatus:newStatus,reason}}));
      return true;
    }catch(e){console.warn(`No se pudo cambiar ${trip?.eco||'UNIDAD'} a ${newStatus}:`,e);return false;}
  }
  async function createAlert(data){
    if(activeAlert(data.eco,data.tipo))return;
    if(incidentAcknowledged(data.eco,data.tipo))return;
    const item={id:`ra-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,...data,estado:'ACTIVA',generado_at:new Date().toISOString(),atendida_at:null};
    alerts.unshift(item);alerts=alerts.slice(0,100);saveJson(LOCAL,alerts);render();alarm();
    try{const r=await window.supabaseClient.from(TABLE).insert(item);if(r.error)throw r.error;}catch(e){console.warn('Persistencia alerta de ruta:',e);}
  }
  async function acknowledge(id){
    const item=alerts.find(a=>a.id===id);if(!item)return;
    item.estado='ATENDIDA';item.atendida_at=new Date().toISOString();
    state[incidentKey(item.eco,item.tipo)]={at:item.atendida_at,id:String(item.id)};
    saveJson(LOCAL,alerts);saveJson(STATE,state);stopAlarm();render();window.dispatchEvent(new CustomEvent('smt:alerta-atendida',{detail:{eco:item.eco,tipo:item.tipo,id:item.id}}));

    try{if(window.supabaseClient)await window.supabaseClient.from(TABLE).update({estado:'ATENDIDA',atendida_at:item.atendida_at}).eq('id',id);}catch(e){console.warn('Atender alerta:',e);}
  }
  function loadPersistedAlerts(){
    alerts=loadJson(LOCAL,[]);if(!Array.isArray(alerts))alerts=[];
    setTimeout(async()=>{try{const r=await window.supabaseClient.from(TABLE).select('*').order('generado_at',{ascending:false}).limit(100);if(!r.error&&Array.isArray(r.data)){const map=new Map();[...alerts,...r.data].forEach(a=>map.set(String(a.id),a));alerts=[...map.values()].sort((a,b)=>String(b.generado_at).localeCompare(String(a.generado_at))).slice(0,100);saveJson(LOCAL,alerts);render();}}catch(_){}},900);
  }
  async function poll(){
    if(busy)return;busy=true;
    try{
      await loadGeofences();
      const trips=await activeTrips(),targets=[];
      for(const t of trips){const u=unitForEco(t.eco);if(!u?.samsara_vehicle_id)continue;const route=await routeForTrip(t);targets.push({trip:t,unit:u,route});}
      const snap=targets.length?await window.SamsaraUI?.getGpsSnapshot?.(targets.map(x=>x.unit.samsara_vehicle_id)):null;
      for(const x of targets){const g=snap?.get(String(x.unit.samsara_vehicle_id));if(!g||!Number.isFinite(Number(g.latitude))||!Number.isFinite(Number(g.longitude)))continue;await evaluate(x,g);}
      saveJson(STATE,state);render();
    }catch(e){console.warn('Alerta ruta:',e);}finally{busy=false;}
  }
  async function evaluate(x,g){
    const eco=String(x.unit.eco),point=[Number(g.latitude),Number(g.longitude)],speed=Number(g.speed);
    const stopped=Number.isFinite(speed)?speed<=STOP_SPEED_MPH:String(g.status||'').toUpperCase().includes('STOP');
    const geofence=findGeofence(point);
    const line=geometry(x.route?.geometria);
    const hasRoute=line.length>=2;
    const d=hasRoute?routeDistance(point,line):null;

    // El cambio de estatus funciona aunque el viaje todavía no tenga ruta trazada.
    const sk=`STOP|${eco}`,sp=state[sk]||{since:null,lastAlert:0,active:false,inGeofence:false,geofenceName:null};
    if(stopped){
      if(!sp.since)sp.since=Date.now();
      sp.duration_ms=Date.now()-sp.since;
      sp.active=sp.duration_ms>=STOP_AFTER;
      sp.inGeofence=Boolean(geofence);
      sp.geofenceName=geofence?.nombre||null;
      if(sp.active&&geofence){
        if(isAfterResguardoHour()&&norm(x.trip.estatus)!=='EN RESGUARDO')await updateTripStatus(x.trip,'EN RESGUARDO',`DETENIDA EN GEOCERCA ${geofence.nombre} DESPUÉS DE LAS 22:00`);
      }else if(hasRoute&&sp.active&&Date.now()-Number(sp.lastAlert||0)>=STOP_COOLDOWN&&!activeAlert(eco,'DETENIDA')&&!incidentAcknowledged(eco,'DETENIDA')){
        sp.lastAlert=Date.now();
        await createAlert({tipo:'DETENIDA',eco,id_viaje:x.trip.id_viaje,origen:x.route?.origen||x.trip.origen||'',destino:x.route?.destino||x.trip.destino||'',municipio:x.route?.municipio??x.trip.municipio??'',distancia_desvio_m:Math.round(d||0),velocidad:g.speed||0,lat:point[0],lng:point[1],ubicacion:g.location||'UBICACIÓN NO DISPONIBLE',mensaje:`LA UNIDAD LLEVA ${Math.round(sp.duration_ms/60000)} MINUTOS DETENIDA.`});
      }
    }else{
      sp.since=null;sp.active=false;sp.duration_ms=0;sp.inGeofence=false;sp.geofenceName=null;
      clearIncidentAcknowledgement(eco,'DETENIDA');
      if(Number.isFinite(speed)&&speed>STOP_SPEED_MPH)await updateTripStatus(x.trip,'EN RUTA','MOVIMIENTO GPS DETECTADO');
    }
    sp.updated_at=new Date().toISOString();state[sk]=sp;

    // Las alertas de ruta sí requieren un trazado guardado.
    if(!hasRoute)return;
    const k=`DEV|${eco}`,prev=state[k]||{outsideCount:0,lastAlert:0,active:false};
    const outside=d>DEVIATION_M;
    if(!outside)clearIncidentAcknowledgement(eco,'DESVIO');
    prev.outsideCount=outside?Number(prev.outsideCount||0)+1:0;
    prev.active=outside;prev.distance=Math.round(d);prev.updated_at=new Date().toISOString();
    if(outside&&prev.outsideCount>=DEVIATION_CONFIRM&&Date.now()-Number(prev.lastAlert||0)>=DEVIATION_COOLDOWN&&!activeAlert(eco,'DESVIO')&&!incidentAcknowledged(eco,'DESVIO')){
      prev.lastAlert=Date.now();
      await createAlert({tipo:'DESVIO',eco,id_viaje:x.trip.id_viaje,origen:x.route?.origen||x.trip.origen||'',destino:x.route?.destino||x.trip.destino||'',municipio:x.route?.municipio??x.trip.municipio??'',distancia_desvio_m:Math.round(d),velocidad:g.speed||0,lat:point[0],lng:point[1],ubicacion:g.location||'UBICACIÓN NO DISPONIBLE',mensaje:`LA UNIDAD SE ENCUENTRA A ${Math.round(d)} METROS DEL TRAZADO PROGRAMADO.`});
    }
    state[k]=prev;
  }
  function getOperationalState(eco){const d=state[`DEV|${eco}`]||null,s=state[`STOP|${eco}`]||null;return{deviation:d,stopped:s};}
  function open(){if(!modal)return;modal.style.display='flex';modal.setAttribute('aria-hidden','false');render();}
  function close(){if(modal){modal.style.display='none';modal.setAttribute('aria-hidden','true');}}
  function render(){
    const box=$('smtAlertList');if(!box)return;const list=alerts.filter(a=>(a.tipo==='DESVIO'||a.tipo==='DETENIDA')&&a.estado==='ACTIVA');
    if(!list.length){box.innerHTML='<div class="smt-alertas-empty"><span>✓</span><strong>SIN ALERTAS OPERATIVAS</strong><small>El sistema vigila las rutas asignadas y las detenciones.</small></div>';updateBadge();return;}
    box.innerHTML=list.map(a=>{const title=a.tipo==='DESVIO'?'DESVÍO DE RUTA':'UNIDAD DETENIDA';const when=formatDate(a.generado_at);return `<article class="smt-alert-card smt-route-alert-card is-active"><div class="smt-alert-card-main"><div class="smt-alert-meta"><span>${esc(a.eco)}</span><span>${title}</span><span>${when}</span></div><h3>${esc(a.origen||'—')} → ${esc(a.destino||'—')}</h3><p>${esc(a.mensaje||'')}</p><div class="smt-alert-context"><span>MUNICIPIO: <b>${esc(a.municipio||'—')}</b></span>${a.tipo==='DESVIO'?`<span>SEPARACIÓN: <b>${Math.round(Number(a.distancia_desvio_m||0))} M</b></span>`:''}<span>GPS: <b>${esc(a.ubicacion||'NO DISPONIBLE')}</b></span></div></div><div class="smt-alert-card-actions"><button type="button" class="btn btn-success smt-alert-ack" data-alert-id="${esc(a.id)}">ATENDER</button></div></article>`;}).join('');
    box.querySelectorAll('.smt-alert-ack').forEach(b=>b.addEventListener('click',()=>acknowledge(b.dataset.alertId)));updateBadge();
  }
  function updateBadge(){const b=$('smtAlertBadge');if(b){const n=alerts.filter(a=>a.estado==='ACTIVA').length;b.textContent=String(n);b.hidden=n===0;document.getElementById('btnAbrirAlertasGps')?.classList.toggle('has-alert',n>0);}}
  function formatDate(v){try{return new Date(v).toLocaleString('es-MX',{dateStyle:'short',timeStyle:'short'});}catch(_){return '';}}
  let audio=null;
  function alarm(){
    try{
      stopAlarm();
      const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;
      audio=new Ctx();
      const ctx=audio;
      const notes=[659.25,783.99,987.77];
      const now=ctx.currentTime+0.04;
      for(let rep=0;rep<3;rep++){
        notes.forEach((freq,i)=>{
          const start=now+rep*0.82+i*0.18;
          const o=ctx.createOscillator(),g=ctx.createGain();
          o.type='sine';o.frequency.setValueAtTime(freq,start);
          g.gain.setValueAtTime(0.0001,start);
          g.gain.exponentialRampToValueAtTime(0.095,start+0.025);
          g.gain.exponentialRampToValueAtTime(0.0001,start+0.15);
          o.connect(g);g.connect(ctx.destination);o.start(start);o.stop(start+0.17);
        });
      }
      ctx.resume?.().catch(()=>{});
      setTimeout(()=>{if(audio===ctx)stopAlarm();},3000);
    }catch(_){}
  }
  function stopAlarm(){try{if(audio){audio.close();audio=null;}}catch(_){} }
  window.SMTAlertasGPS={open,close,refresh:poll,getOperationalState,getDeviation:eco=>{const d=state[`DEV|${eco}`]||null;return d?.active&&!incidentAcknowledged(eco,'DESVIO')?d:null;}};
})();
