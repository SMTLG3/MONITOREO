/* ============================================================
   V78 — MOTOR DE RUTAS INTELIGENTES
   CAPAS 2-4:
   - Geocerca circular de destino
   - Aprendizaje desde históricos Samsara
   - Ruta planeada vs GPS real
   - Detección de desviación con cooldown
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ORANGE = "#FF8A00";
  const BLUE = "#1677FF";
  const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
  const DEFAULT_DEVIATION_M = 1000;

  function norm(v) {
    return String(v || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/\s+/g, " ").trim();
  }

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  }

  function distanceMeters(a, b) {
    const R = 6371000;
    const lat1 = Number(a[0]) * Math.PI / 180;
    const lat2 = Number(b[0]) * Math.PI / 180;
    const dLat = (Number(b[0]) - Number(a[0])) * Math.PI / 180;
    const dLng = (Number(b[1]) - Number(a[1])) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function pointToSegmentDistanceMeters(p, a, b) {
    const lat = p[0] * Math.PI / 180;
    const kx = Math.cos(lat) * 111320;
    const ky = 110540;
    const ax = a[1] * kx, ay = a[0] * ky;
    const bx = b[1] * kx, by = b[0] * ky;
    const px = p[1] * kx, py = p[0] * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function distanceToRouteMeters(point, latlngs) {
    if (!Array.isArray(latlngs) || latlngs.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 1; i < latlngs.length; i++) {
      const d = pointToSegmentDistanceMeters(point, latlngs[i - 1], latlngs[i]);
      if (d < best) best = d;
    }
    return best;
  }

  function routeKey(origen, destino, municipio) {
    const o = norm(origen), d = norm(destino), m = norm(municipio);
    return o && d ? `${o}__${d}__${m}` : "";
  }

  async function invoke(action, extra = {}) {
    if (!window.supabaseClient) throw new Error("SUPABASE NO ESTÁ DISPONIBLE.");
    const { data, error } = await window.supabaseClient.functions.invoke("samsara-proxy", { body: { action, ...extra } });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "ERROR EN SAMSARA.");
    return data.data;
  }

  async function linkedVehicleId(eco) {
    const { data, error } = await window.supabaseClient.from("unidades").select("samsara_vehicle_id").eq("eco", eco).maybeSingle();
    if (error) throw error;
    return data?.samsara_vehicle_id ? String(data.samsara_vehicle_id) : null;
  }

  function normalizeGeofenceRow(row) {
    if (!row) return null;
    const geo = row.geocerca || row.geometry || row.geometria || row.geofence || row.shape || null;
    let lat = Number(row.lat ?? row.latitude ?? row.center_lat ?? row.centro_lat ?? geo?.lat ?? geo?.latitude ?? geo?.center?.lat ?? geo?.center?.latitude);
    let lng = Number(row.lng ?? row.longitude ?? row.lon ?? row.center_lng ?? row.centro_lng ?? geo?.lng ?? geo?.longitude ?? geo?.center?.lng ?? geo?.center?.longitude);
    const coords = geo?.coordinates || row.coordinates || row.coordenadas || null;
    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && Array.isArray(coords)) {
      let pair = coords;
      while (Array.isArray(pair?.[0]) && pair.length) pair = pair[0];
      if (Array.isArray(pair) && pair.length >= 2) {
        const a = Number(pair[0]), b = Number(pair[1]);
        if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lng = b; }
        else if (Math.abs(b) <= 90 && Math.abs(a) <= 180) { lat = b; lng = a; }
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { ...row, lat, lng, nombre: row.nombre || row.name || row.descripcion || "GEOCERCA SIN NOMBRE", radio_metros: Number(row.radio_metros ?? row.radius_meters ?? row.radiusMeters ?? geo?.radiusMeters ?? 300) || 300 };
  }

  async function findDestinationGeofence(destination, municipality) {
    const target = norm(municipality || destination);
    const { data, error } = await window.supabaseClient
      .from("monitoreo_geocercas")
      .select("*")
      .eq("activo", true);
    if (error) throw error;
    let rows = (data || []).map(normalizeGeofenceRow).filter(Boolean);
    if (!rows.length && window.SamsaraUI?.getAddresses) {
      try {
        const addresses = await window.SamsaraUI.getAddresses();
        rows = (addresses || []).map(row => {
          const geo = row?.geofence || row?.geometry || row?.geometria || row?.shape || null;
          let lat = Number(row?.latitude ?? row?.lat ?? geo?.latitude ?? geo?.lat ?? geo?.circle?.latitude ?? geo?.circle?.lat);
          let lng = Number(row?.longitude ?? row?.lng ?? row?.lon ?? geo?.longitude ?? geo?.lng ?? geo?.circle?.longitude ?? geo?.circle?.lng);
          if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && Array.isArray(geo?.coordinates)) {
            let pair = geo.coordinates;
            while (Array.isArray(pair?.[0]) && pair.length) pair = pair[0];
            if (Array.isArray(pair) && pair.length >= 2) {
              const a=Number(pair[0]), b=Number(pair[1]);
              if (Math.abs(a)<=90 && Math.abs(b)<=180) { lat=a; lng=b; }
              else if (Math.abs(b)<=90 && Math.abs(a)<=180) { lat=b; lng=a; }
            }
          }
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          return { ...row, lat, lng, nombre: row.name || row.nombre || row.description || "GEOCERCA SAMSARA" };
        }).filter(Boolean);
      } catch (_) {}
    }
    return rows.find(z => norm(z.nombre) === target) ||
      rows.find(z => norm(z.nombre).includes(target) || target.includes(norm(z.nombre))) || null;
  }

  function geometryToLatLngs(geometry) {
    if (!geometry) return [];
    if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
      return geometry.coordinates.map(p => [Number(p[1]), Number(p[0])]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    }
    if (geometry.type === "Feature" && geometry.geometry) return geometryToLatLngs(geometry.geometry);
    return [];
  }

  async function getSavedRoute(key) {
    const { data, error } = await window.supabaseClient.from("rutas_trazadas").select("*").eq("clave", key).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function learnFromSamsara({ vehicleId, key, origin, destination, lookbackDays = 60 }) {
    if (!vehicleId) return null;
    const result = await invoke("learnRoute", {
      vehicleId,
      originLat: origin.lat,
      originLng: origin.lng,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
      lookbackDays: Math.min(90, Math.max(7, Number(lookbackDays) || 60))
    });
    const points = Array.isArray(result?.points) ? result.points.map(p => [Number(p.latitude), Number(p.longitude)]) : [];
    if (points.length < 2) return null;

    const payload = {
      clave: key,
      origen: origin.label || origin.name || "ORIGEN",
      destino: destination.label || destination.name || "DESTINO",
      municipio: destination.municipio || "",
      tipo: "SAMSARA_APRENDIDA",
      geometria: { type: "LineString", coordinates: points.map(p => [p[1], p[0]]) },
      distancia_km: Number(result.distanceKm || 0) || null,
      duracion_min: Number(result.durationMin || 0) || null,
      muestras: Number(result.samples || 1),
      confianza: Number(result.confidence || 0) || null,
      fuente: "SAMSARA",
      actualizado_at: new Date().toISOString()
    };
    const saved = await window.supabaseClient.from("rutas_aprendidas").upsert(payload, { onConflict: "clave" }).select().maybeSingle();
    if (saved.error) console.warn("No se pudo guardar ruta aprendida:", saved.error);
    return { ...payload, ...(saved.data || {}) };
  }

  async function prepareRoute({ eco, origen, destino, municipio, originPoint, destinationPoint, onStatus }) {
    const key = routeKey(origen, destino, municipio);
    if (!key) throw new Error("FALTAN ORIGEN Y DESTINO.");
    const saved = await getSavedRoute(key).catch(() => null);
    if (saved?.geometria) {
      onStatus?.("🟠 RUTA PREVIAMENTE GUARDADA · REUTILIZANDO TRAZO.");
      return { route: saved, source: "GUARDADA" };
    }

    let vehicleId = null;
    try { vehicleId = await linkedVehicleId(eco || $("eco")?.value.trim() || ""); } catch (_) {}
    let geofence = null;
    try { geofence = await findDestinationGeofence(destino, municipio); } catch (_) {}

    if (vehicleId) {
      onStatus?.("SAMSARA · BUSCANDO RECORRIDOS ANTERIORES…");
      try {
        const learned = await learnFromSamsara({
          vehicleId,
          key,
          origin: { ...originPoint, label: origen },
          destination: { ...destinationPoint, label: municipio, municipio },
          lookbackDays: 60
        });
        if (learned) {
          learned.geofence = geofence;
          return { route: learned, source: "SAMSARA_APRENDIDA", geofence };
        }
      } catch (error) {
        console.warn("Aprendizaje Samsara:", error);
        onStatus?.("SAMSARA SIN HISTÓRICO SUFICIENTE · USANDO RUTA DE CARRETERA…");
      }
    }
    return { route: null, source: "AUTOMATICA", geofence, vehicleId };
  }

  async function attachMonitoringToMap(state, route, geofence) {
    if (!state?.map || !window.L) return;
    if (state.routeLayer) state.routeLayer.clearLayers();
    else state.routeLayer = L.layerGroup().addTo(state.map);
    if (state.geofenceLayer) state.geofenceLayer.clearLayers();
    else state.geofenceLayer = L.layerGroup().addTo(state.map);

    const points = geometryToLatLngs(route?.geometria);
    if (points.length > 1) {
      state.routeLayer.addLayer(L.polyline(points, { color: ORANGE, weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" }));
    }

    if (geofence && Number.isFinite(Number(geofence.lat)) && Number.isFinite(Number(geofence.lng))) {
      const circle = L.circle([Number(geofence.lat), Number(geofence.lng)], {
        radius: Number(geofence.radio_metros || 300),
        color: "#16A34A", weight: 2, fillOpacity: .08
      }).bindTooltip(`GEOCERCA · ${esc(geofence.nombre || "DESTINO")}`, { sticky: true });
      state.geofenceLayer.addLayer(circle);
    }
  }

  async function checkDeviation(state, point) {
    if (!state?.map || !point || !window.supabaseClient) return null;
    const route = state.plannedRoute;
    const latlngs = geometryToLatLngs(route?.geometria);
    if (latlngs.length < 2) return null;
    const distance = distanceToRouteMeters([Number(point.latitude), Number(point.longitude)], latlngs);
    const threshold = Number(route?.desviacion_metros || DEFAULT_DEVIATION_M);
    const active = distance > threshold;
    const now = Date.now();
    if (active) {
      const last = Number(state.lastDeviationAlert || 0);
      if (now - last > ALERT_COOLDOWN_MS) {
        state.lastDeviationAlert = now;
        const payload = {
          id_viaje: state.tripId ? String(state.tripId) : null,
          eco: state.eco || null,
          clave: route.clave || null,
          distancia_metros: Math.round(distance),
          umbral_metros: threshold,
          lat: Number(point.latitude),
          lng: Number(point.longitude),
          atendida: false,
          creado_at: new Date().toISOString()
        };
        const result = await window.supabaseClient.from("ruta_desviaciones").insert(payload);
        if (result.error) console.warn("No se guardó desviación:", result.error);
        window.dispatchEvent(new CustomEvent("smt:ruta-desviacion", { detail: payload }));
      }
    }
    return { active, distance, threshold };
  }

  function bindAlert() {
    window.addEventListener("smt:ruta-desviacion", event => {
      const d = event.detail || {};
      const text = `⚠️ DESVIACIÓN DE RUTA · ${d.eco || "UNIDAD"}\nSeparación aproximada: ${Math.round(Number(d.distancia_metros || 0))} m`;
      if (typeof window.mostrarToast === "function") window.mostrarToast("Desviación de ruta", text);
      else console.warn(text);
    });
  }

  window.SMTRutaInteligente = {
    routeKey,
    findDestinationGeofence,
    getSavedRoute,
    prepareRoute,
    attachMonitoringToMap,
    checkDeviation,
    geometryToLatLngs,
    distanceToRouteMeters,
    ORANGE,
    BLUE
  };

  document.addEventListener("DOMContentLoaded", bindAlert);
})();
