/* ============================================================
   V95 — CAMPOS DE RUTA EN MAYÚSCULAS SIN BLOQUEAR ESPACIOS
   PRIORIDAD: la línea naranja SIEMPRE debe visualizarse.
   - Leaflet + Esri robusto
   - Ruta automática OSRM dibujada primero
   - Samsara/inteligencia se consulta DESPUÉS, sin bloquear el mapa
   - Geocerca local únicamente circular
   - Trazo manual
   - Guardado Supabase + respaldo local
   - V89: al guardar se persiste exactamente la geometría visible tras cualquier ajuste
   ============================================================ */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  function routeField(id) {
    const map = { origen: "rutaOrigen", destino: "rutaDestino", municipio: "rutaMunicipio" };
    const modalEl = $(map[id]);
    const planner = $("modalPlanificadorRuta");
    if (modalEl && planner && isVisible(planner)) return modalEl;
    return $(id) || modalEl;
  }
  function routeValue(id) { return routeField(id)?.value?.trim() || ""; }
  function syncRouteFieldsToTrip() {
    ["origen","destino","municipio"].forEach(id => {
      const a = routeField(id), b = $(id);
      if (a && b && a !== b && a.value.trim()) b.value = upperRouteValue(a.value);
    });
  }
  const TABLE = "rutas_trazadas";
  const LOCAL_KEY = "SMT_RUTAS_TRAZADAS_V77";
  const MAP_VIEW_KEY = "SMT_SAMSARA_MAP_VIEW";
  const ORIGIN = [23.6345, -102.5528];
  const ORANGE = "#FF8A00";

  let map = null;
  let street = null;
  let satellite = null;
  let transport = null;
  let labels = null;
  let plannedLine = null;
  let manualLine = null;
  let markers = null;
  let geofenceLayer = null;
  let manualMode = false;
  let manualAnchorMarker = null;
  let manualRouteContext = null;
  let manualRequestToken = 0;
  let currentTrace = null;
  let municipalityTimer = null;
  let lastMunicipalityQuery = "";
  let loadedGeofences = [];
  let geofenceSignature = "";
  let geofencePollTimer = null;
  let editMode = false;
  let editHandles = [];
  let editAnchors = [];
  let editRequestToken = 0;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bind();
    restorePlannerMapVisibility();
    const modal = $("modalPlanificadorRuta");
    if (modal) {
      new MutationObserver(() => {
        if (isVisible(modal)) setTimeout(() => ensureMap(true), 80);
      }).observe(modal, { attributes: true, attributeFilter: ["style", "class", "aria-hidden"] });
    }
    // El mapa solo se inicializa cuando el modal propio de ruta está visible.
    setTimeout(() => loadGeofences(false), 1200);
    setTimeout(() => checkForNewGeofences(), 2200);
    geofencePollTimer = setInterval(checkForNewGeofences, 15000);
  }

  function bind() {
    $("btnCargarGeocercas")?.addEventListener("click", () => loadGeofences(true));
    $("btnRutaAutomatica")?.addEventListener("click", buildAutomaticRoute);
    $("btnRutaManual")?.addEventListener("click", startManual);
    $("btnTerminarTrazo")?.addEventListener("click", finishManual);
    $("btnLimpiarTrazo")?.addEventListener("click", clearAll);
    $("btnGuardarTrazo")?.addEventListener("click", saveCurrent);
    $("btnLimpiarDatosRuta")?.addEventListener("click", clearRouteRegistrationFields);
    $("cerrarRegistroRuta")?.addEventListener("click", closeSaveRegistration);
    $("cancelarRegistroRuta")?.addEventListener("click", closeSaveRegistration);
    $("confirmarRegistroRuta")?.addEventListener("click", confirmSaveRegistration);
    $("modalRegistroRuta")?.addEventListener("click", event => {
      if (event.target?.id === "modalRegistroRuta") closeSaveRegistration();
    });
    $("btnAjustarTrazo")?.addEventListener("click", toggleEditMode);

    $("btnAbrirPlanificadorRuta")?.addEventListener("click", openPlannerModal);
    $("btnVolverAlertasDesdeRuta")?.addEventListener("click", openAlertsFromPlanner);
    $("btnAbrirRutasGuardadasDesdeGestion")?.addEventListener("click", () => {
      closePlannerModal();
      window.SMTRutasTrazadasViewer?.open?.();
    });
    $("cerrarPlanificadorRuta")?.addEventListener("click", closePlannerModal);
    $("btnOcultarMapaRuta")?.addEventListener("click", togglePlannerMapVisibility);

    ["rutaOrigen","rutaDestino","rutaMunicipio"].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => {
        enforceUpperRouteField(id, true);
        syncRouteFieldsToTrip();
        if (id === "rutaDestino") loadMunicipalities();
      });
      el.addEventListener("change", () => {
        enforceUpperRouteField(id);
        syncRouteFieldsToTrip();
        if (id === "rutaDestino") loadMunicipalities();
        if (!manualMode) loadSavedRoute();
      });
      el.addEventListener("blur", () => {
        enforceUpperRouteField(id);
        syncRouteFieldsToTrip();
      });
    });

    ["registroRutaOrigen","registroRutaDestino","registroRutaMunicipio"].forEach(id => {
      const el = $(id);
      if (!el) return;
      ["input","change","blur"].forEach(evt => el.addEventListener(evt, () => enforceUpperRouteField(id, evt === "input")));
    });

    ["origen","destino","municipio"].forEach(id => {
      const el = $(id);
      if (!el) return;
      ["input","change","blur"].forEach(evt => el.addEventListener(evt, () => {
        enforceUpperRouteField(id, evt === "input");
        syncRouteFieldsToTrip();
      }));
    });

    $("eco")?.addEventListener("change", () => {
      setTimeout(() => {
        const eco = $("eco")?.value.trim();
        const origen = routeValue("origen");
        const destino = routeValue("destino");
        const municipio = routeValue("municipio");
        if (eco && origen && destino && !manualMode) {
          buildAutomaticRoute();
        }
      }, 120);
    });

    ["origen", "destino", "municipio"].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => { if (window.SMTRutaPlanner?.previewNewTripRoute) window.SMTRutaPlanner.previewNewTripRoute(); });
      el.addEventListener("change", () => {
        if (id === "destino") loadMunicipalities();
        if (window.SMTRutaPlanner?.previewNewTripRoute) window.SMTRutaPlanner.previewNewTripRoute();
      });
      el.addEventListener("blur", () => { if (window.SMTRutaPlanner?.previewNewTripRoute) window.SMTRutaPlanner.previewNewTripRoute(); });
    });

    $("municipio")?.addEventListener("input", () => {
      clearTimeout(municipalityTimer);
      municipalityTimer = setTimeout(loadMunicipalities, 450);
    });



    $("sugerenciasMunicipioViaje")?.addEventListener("pointerdown", event => {
      const item = event.target.closest("button[data-name]");
      if (!item) return;
      event.preventDefault();
      $("municipio").value = item.dataset.name || "";
      $("sugerenciasMunicipioViaje").hidden = true;
      loadSavedRoute();
    });
  }

  function openPlannerModal() {
    ["origen","destino","municipio"].forEach(id => {
      const trip = $(id), modalEl = routeField(id);
      if (trip && modalEl && trip.value.trim()) modalEl.value = upperRouteValue(trip.value);
    });
    const alertModal = $("modalAlertasGps");
    if (alertModal) { alertModal.style.display = "none"; alertModal.setAttribute("aria-hidden", "true"); }
    const modal = $("modalPlanificadorRuta");
    if (!modal) return;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      ensureMap(true);
      updateAccessCard();
    });
  }

  function closePlannerModal() {
    const modal = $("modalPlanificadorRuta");
    if (!modal) return;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  function openAlertsFromPlanner() {
    closePlannerModal();
    const modal = $("modalAlertasGps");
    if (!modal) return;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    window.SMTAlertasGPS?.open?.();
  }

  function togglePlannerMapVisibility() {
    const mapEl = $("rutaPlannerMap");
    const button = $("btnOcultarMapaRuta");
    if (!mapEl || !button) return;
    const hidden = mapEl.hidden || getComputedStyle(mapEl).display === "none";
    mapEl.hidden = !hidden;
    mapEl.style.display = hidden ? "block" : "none";
    button.textContent = hidden ? "◉" : "◎";
    button.setAttribute("aria-label", hidden ? "Ocultar mapa" : "Mostrar mapa");
    button.title = hidden ? "Ocultar mapa" : "Mostrar mapa";
    try { localStorage.setItem("SMT_RUTA_MAPA_OCULTO_V81", hidden ? "0" : "1"); } catch (_) {}
    if (hidden) setTimeout(() => repair(), 80);
  }

  function restorePlannerMapVisibility() {
    const mapEl = $("rutaPlannerMap");
    const button = $("btnOcultarMapaRuta");
    if (!mapEl || !button) return;
    let hidden = false;
    try { hidden = localStorage.getItem("SMT_RUTA_MAPA_OCULTO_V81") === "1"; } catch (_) {}
    mapEl.hidden = hidden;
    mapEl.style.display = hidden ? "none" : "block";
    button.textContent = hidden ? "◎" : "◉";
    button.setAttribute("aria-label", hidden ? "Mostrar mapa" : "Ocultar mapa");
    button.title = hidden ? "Mostrar mapa" : "Ocultar mapa";
  }

  function updateAccessCard() {
    const state = $("rutaAccessState");
    const summary = $("rutaAccessSummary");
    if (!state || !summary) return;
    if (!currentTrace?.geometry) {
      state.textContent = "SIN TRAZO";
      summary.textContent = "Genera la ruta por carretera y guárdala para el seguimiento.";
      return;
    }
    const km = Number(currentTrace.distancia_km || 0);
    state.textContent = "LISTA";
    summary.textContent = `${currentTrace.fuente || "RUTA POR CARRETERA"}${km ? ` · ${km.toFixed(1)} KM` : ""} · AJUSTABLE`;
  }

  function isVisible(el) {
    const s = getComputedStyle(el);
    return s.display !== "none" && el.getAttribute("aria-hidden") !== "true";
  }

  function getMapMode() {
    try {
      const saved = localStorage.getItem(MAP_VIEW_KEY);
      return saved === "normal" ? "normal" : "hybrid";
    } catch (_) {
      return "hybrid";
    }
  }

  function ensureMap(invalidate = true) {
    const el = $("rutaPlannerMap");
    if (!el || !window.L) return null;

    if (!map) {
      map = L.map(el, {
        zoomControl: true,
        attributionControl: true,
        inertia: true,
        worldCopyJump: true,
        zoomSnap: 1,
        zoomDelta: 1,
        minZoom: 3,
        maxZoom: 19,
        preferCanvas: false,
        tap: true
      }).setView(ORIGIN, 5);

      street = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
        { minZoom: 3, maxZoom: 19, maxNativeZoom: 19, keepBuffer: 4, updateWhenIdle: true, attribution: "Mapa © Esri" }
      );
      satellite = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { minZoom: 3, maxZoom: 19, maxNativeZoom: 18, keepBuffer: 4, updateWhenIdle: true, attribution: "Imagen © Esri" }
      );
      transport = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
        { minZoom: 3, maxZoom: 19, maxNativeZoom: 18, keepBuffer: 4, updateWhenIdle: true, attribution: "Transporte © Esri" }
      );
      labels = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        { minZoom: 3, maxZoom: 19, maxNativeZoom: 18, keepBuffer: 4, updateWhenIdle: true, attribution: "Lugares © Esri" }
      );

      applyBasemap(getMapMode());

      const ctrl = L.control({ position: "topright" });
      ctrl.onAdd = () => {
        const b = L.DomUtil.create("button", "ruta-basemap-toggle");
        b.type = "button";
        const update = mode => {
          b.classList.toggle("is-satellite", mode === "hybrid");
          b.classList.toggle("is-normal", mode === "normal");
          b.title = mode === "hybrid" ? "Cambiar a mapa normal" : "Cambiar a vista satelital";
          b.setAttribute("aria-label", b.title);
        };
        update(getMapMode());
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, "click", () => {
          const next = getMapMode() === "hybrid" ? "normal" : "hybrid";
          applyBasemap(next);
          update(next);
          repair();
        });
        return b;
      };
      ctrl.addTo(map);

      plannedLine = L.polyline([], {
        color: ORANGE,
        weight: 8,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        interactive: false
      }).addTo(map);

      manualLine = L.polyline([], {
        color: ORANGE,
        weight: 8,
        opacity: 1,
        dashArray: "10 8",
        lineCap: "round",
        lineJoin: "round",
        interactive: false
      }).addTo(map);

      markers = L.layerGroup().addTo(map);
      geofenceLayer = L.layerGroup().addTo(map);

      map.on("click", e => {
        if (!manualMode || !manualRouteContext) return;
        // V86: el modo manual usa UN SOLO punto de ajuste.
        // Ese punto se convierte en un anclaje entre origen y destino;
        // OSRM dibuja automáticamente la carretera completa.
        if (manualAnchorMarker) return;
        createManualAnchor(e.latlng);
      });

      [street, satellite, transport, labels].forEach(layer => {
        layer.on("tileerror", () => setTimeout(repair, 120));
      });
    }

    if (invalidate) {
      [0, 80, 220, 500, 900].forEach(ms => setTimeout(repair, ms));
    }
    return map;
  }

  function applyBasemap(mode) {
    if (!map) return;
    [street, satellite, transport, labels].forEach(layer => {
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    });

    if (mode === "hybrid") {
      satellite.addTo(map);
      transport.addTo(map);
      labels.addTo(map);
    } else {
      street.addTo(map);
    }

    try { localStorage.setItem(MAP_VIEW_KEY, mode); } catch (_) {}
    plannedLine?.bringToFront();
    manualLine?.bringToFront();
    markers?.bringToFront();
    if (geofenceLayer?.eachLayer) geofenceLayer.eachLayer(layer => { if (typeof layer?.bringToFront === "function") layer.bringToFront(); });
  }

  function repair() {
    if (!map) return;
    try { map.invalidateSize({ animate: false, pan: false }); } catch (_) {}
    plannedLine?.bringToFront();
    manualLine?.bringToFront();
  }

  async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=mx&q=${encodeURIComponent(query + ", Mexico")}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("NO SE PUDO CONSULTAR EL MAPA.");
    const rows = await response.json();
    if (!rows[0]) throw new Error(`NO ENCONTRÉ LA UBICACIÓN: ${query}`);
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lon), label: rows[0].display_name };
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/\s+/g, " ").trim();
  }

  function geofenceMatches(zone, destination, municipality) {
    const z = normalizeText(zone?.nombre);
    const d = normalizeText(destination);
    const m = normalizeText(municipality);
    if (!z) return false;
    const tokens = [d, m].filter(Boolean);
    return tokens.some(t => z === t || z.includes(t) || t.includes(z));
  }

  function matchingGeofence(destination, municipality) {
    return loadedGeofences.find(z => geofenceMatches(z, destination, municipality)) || null;
  }

  // Regla operacional: cuando el usuario escribe MATRIZ, el sistema busca
  // automáticamente la geocerca cuyo nombre contiene MATRIZ (por ejemplo
  // "GCI MATRIZ TALLER, TULA"). No se obliga al usuario a seleccionar una lista.
  function matchingOriginGeofence(origen) {
    const o = normalizeText(origen);
    if (!o) return null;
    return loadedGeofences.find(z => {
      const n = normalizeText(z?.nombre);
      return o === "MATRIZ" ? n.includes("MATRIZ") : (n === o || n.includes(o) || o.includes(n));
    }) || null;
  }

  function normalizeGeofenceRow(row) {
    if (!row) return null;

    // La geocerca NO tiene que venir como "circle" en Supabase.
    // Puede venir como Samsara la entregue (circle/polygon) o con sus
    // coordenadas separadas. Para este sistema solamente tomamos su
    // LOCALIZACION (centro) y nosotros la dibujamos como circulo.
    const geo = row.geocerca || row.geometry || row.geometria || row.geofence || row.shape || null;
    let lat = Number(row.lat ?? row.latitude ?? row.center_lat ?? row.centro_lat ?? geo?.lat ?? geo?.latitude ?? geo?.center?.lat ?? geo?.center?.latitude);
    let lng = Number(row.lng ?? row.longitude ?? row.lon ?? row.center_lng ?? row.centro_lng ?? geo?.lng ?? geo?.longitude ?? geo?.center?.lng ?? geo?.center?.longitude);

    // Algunos registros guardan coordinates como [lng,lat] o [lat,lng].
    const coords = geo?.coordinates || row.coordinates || row.coordenadas || null;
    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && Array.isArray(coords)) {
      let pair = coords;
      // Si viene un polígono, usamos el primer punto como referencia;
      // el circulo visual será centrado en esa localización.
      while (Array.isArray(pair?.[0]) && pair.length) pair = pair[0];
      if (Array.isArray(pair) && pair.length >= 2) {
        const a = Number(pair[0]), b = Number(pair[1]);
        if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lng = b; }
        else if (Math.abs(b) <= 90 && Math.abs(a) <= 180) { lat = b; lng = a; }
      }
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      ...row,
      lat,
      lng,
      radio_metros: Number(row.radio_metros ?? row.radius_meters ?? row.radiusMeters ?? geo?.radiusMeters ?? geo?.radius_meters ?? 300) || 300,
      nombre: row.nombre || row.name || row.descripcion || "GEOCERCA SIN NOMBRE"
    };
  }

  function normalizeSamsaraAddress(row) {
    if (!row) return null;
    const geo = row.geofence || row.geometry || row.geometria || row.shape || null;
    let lat = Number(row.latitude ?? row.lat ?? row.center?.latitude ?? row.center?.lat ?? geo?.latitude ?? geo?.lat ?? geo?.circle?.latitude ?? geo?.circle?.lat ?? geo?.center?.latitude ?? geo?.center?.lat);
    let lng = Number(row.longitude ?? row.lng ?? row.lon ?? row.center?.longitude ?? row.center?.lng ?? geo?.longitude ?? geo?.lng ?? geo?.circle?.longitude ?? geo?.circle?.lng ?? geo?.center?.longitude ?? geo?.center?.lng);
    const coords = geo?.coordinates || row.coordinates || row.coordenadas || geo?.polygon?.coordinates || geo?.polygon?.vertices || null;
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
    const circle = geo?.circle || row.circle || null;
    return {
      ...row,
      lat,
      lng,
      nombre: row.name || row.nombre || row.description || "GEOCERCA SAMSARA",
      radio_metros: Number(circle?.radiusMeters ?? row.radiusMeters ?? row.radio_metros ?? 300) || 300,
      activo: true,
      samsara_address_id: row.id != null ? String(row.id) : null,
      fuente_geocerca: "SAMSARA"
    };
  }

  async function fetchGeofencesMeta() {
    if (!window.supabaseClient) return [];

    // 1) Primero usamos las geocercas ya sincronizadas en Supabase.
    const local = await window.supabaseClient
      .from("monitoreo_geocercas")
      .select("*")
      .eq("activo", true)
      .order("nombre", { ascending: true });
    if (local.error) throw local.error;
    const localRows = (local.data || []).map(normalizeGeofenceRow).filter(Boolean);
    if (localRows.length) return localRows;

    // 2) Si Supabase aún no tiene coordenadas, pedimos las direcciones/geocercas
    // directamente a Samsara. NO exigimos que Samsara diga "circle".
    // Tomamos nombre + localización y ESTE SISTEMA las representa como círculo.
    if (window.SamsaraUI?.getAddresses) {
      const addresses = await window.SamsaraUI.getAddresses();
      const directRows = (addresses || []).map(normalizeSamsaraAddress).filter(Boolean);
      if (directRows.length) return directRows.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), "es"));
    }

    return [];
  }

  function setGeofenceButtonVisible(visible, text = "◉ CARGAR GEOCERCAS") {
    const button = $("btnCargarGeocercas");
    if (!button) return;
    button.hidden = !visible;
    button.disabled = false;
    button.textContent = text;
  }

  function renderGeofenceList() {
    const panel = $("rutaGeocercasPanel");
    const list = $("rutaGeocercasLista");
    const count = $("rutaGeocercasCount");
    const state = $("rutaGeocercasEstado");
    if (!panel || !list || !count || !state) return;

    panel.hidden = true;
    count.textContent = `${loadedGeofences.length} GEOCERCA${loadedGeofences.length === 1 ? "" : "S"}`;
    state.textContent = loadedGeofences.length ? "CARGADAS" : "NO CARGADAS";
    list.innerHTML = loadedGeofences.map((zone, index) => `
      <button type="button" class="ruta-geocerca-item" data-geofence-index="${index}" title="Usar ${esc(zone.nombre)} como destino">
        <span class="ruta-geocerca-dot"></span>
        <span class="ruta-geocerca-name">${esc(zone.nombre || "SIN NOMBRE")}</span>
        <small>${Number(zone.radio_metros || 0).toFixed(0)} m</small>
      </button>`).join("");

    list.querySelectorAll("[data-geofence-index]").forEach(button => {
      button.addEventListener("click", () => selectGeofence(Number(button.dataset.geofenceIndex)));
    });
  }

  function selectGeofence(index) {
    const zone = loadedGeofences[index];
    if (!zone) return;
    const municipio = $("municipio");
    if (municipio && !municipio.value.trim()) municipio.value = zone.nombre || "";
    drawGeofence(zone);
    ensureMap(true);
    try {
      map.setView([Number(zone.lat), Number(zone.lng)], Math.max(10, Math.min(15, map.getZoom())), { animate: true });
    } catch (_) {}
    setStatus(`🟢 GEOCERCA SELECCIONADA · ${zone.nombre}. AL TRAZAR, SU CENTRO SE USARÁ COMO DESTINO.`);
    updateGeofenceSelectionVisual(index);
  }

  function updateGeofenceSelectionVisual(index) {
    document.querySelectorAll(".ruta-geocerca-item").forEach((el, i) => el.classList.toggle("is-selected", i === index));
  }

  async function loadGeofences(fromButton = false) {
    const button = $("btnCargarGeocercas");
    if (button) button.disabled = true;
    try {
      const rows = await fetchGeofencesMeta();
      loadedGeofences = rows;
      geofenceSignature = rows.map(z => `${z.id}:${z.updated_at || ""}:${z.nombre || ""}`).join("|");
      renderGeofenceList();
      setGeofenceButtonVisible(false);
      if (rows.length) {
        drawAllGeofences();
        setStatus(`🟢 ${rows.length} GEOCERCAS ACTIVAS · MAPA ACTUALIZADO.`);
      } else {
        setStatus("NO HAY GEOCERCAS CON LOCALIZACIÓN DISPONIBLE EN SUPABASE NI EN SAMSARA.", true);
        setGeofenceButtonVisible(true);
      }
    } catch (error) {
      console.warn("Carga de geocercas:", error);
      setStatus("NO SE PUDIERON CARGAR LAS GEOCERCAS.", true);
      setGeofenceButtonVisible(true);
    } finally {
      if (fromButton && button) button.disabled = false;
    }
  }

  function drawAllGeofences() {
    ensureMap(true);
    geofenceLayer?.clearLayers();
    loadedGeofences.forEach(zone => {
      const radius = Math.max(30, Number(zone.radio_metros || 300));
      L.circle([Number(zone.lat), Number(zone.lng)], {
        radius,
        color: "#16A34A",
        weight: 1.5,
        fillColor: "#16A34A",
        fillOpacity: 0.07,
        interactive: false
      }).addTo(geofenceLayer);
    });
    if (geofenceLayer?.eachLayer) geofenceLayer.eachLayer(layer => { if (typeof layer?.bringToFront === "function") layer.bringToFront(); });
    repair();
  }

  async function checkForNewGeofences() {
    try {
      const rows = await fetchGeofencesMeta();
      const signature = rows.map(z => `${z.id}:${z.updated_at || ""}:${z.nombre || ""}`).join("|");
      if (!geofenceSignature) {
        if (rows.length) setGeofenceButtonVisible(true, `◉ CARGAR GEOCERCAS · ${rows.length} DISPONIBLES`);
        return;
      }
      if (signature !== geofenceSignature) {
        setGeofenceButtonVisible(true, "◉ CARGAR NUEVAS GEOCERCAS");
        const nuevos = Math.max(0, rows.length - loadedGeofences.length);
        setStatus(nuevos ? `🟢 HAY ${nuevos} GEOCERCA${nuevos === 1 ? "" : "S"} NUEVA${nuevos === 1 ? "" : "S"} · CÁRGALAS PARA ACTUALIZAR EL MAPA.` : "🟢 LAS GEOCERCAS CAMBIARON · CÁRGALAS DE NUEVO.");
      }
    } catch (_) {}
  }

  async function getRoutePoints() {
    const origen = routeValue("origen");
    const destino = routeValue("destino");
    const municipio = routeValue("municipio");
    if (!origen || !destino) {
      setStatus("CAPTURA ORIGEN Y DESTINO. EL MUNICIPIO / ALCALDÍA ES OPCIONAL.", true);
      return null;
    }
    setStatus("ANALIZANDO GEOCERCAS Y UBICANDO ORIGEN / DESTINO…");
    const originZone = matchingOriginGeofence(origen);
    const a = originZone
      ? { lat: Number(originZone.lat), lng: Number(originZone.lng), label: originZone.nombre, geocerca: originZone }
      : await geocode(origen);
    const zone = matchingGeofence(destino, municipio);
    let b;
    if (zone) {
      b = { lat: Number(zone.lat), lng: Number(zone.lng), label: zone.nombre, geocerca: zone };
      drawGeofence(zone);
      setStatus("🟢 DESTINO LOCALIZADO · CALCULANDO CARRETERA…");
    } else {
      b = await geocode(municipio ? `${municipio}, ${destino}` : destino);
    }
    return { origen: a, destino: b, origenText: origen, destinoText: destino, municipio, geocerca: zone, origenGeocerca: originZone };
  }

  async function requestOsrmRoute(points) {
    return requestOsrmRouteThroughAnchors([
      [Number(points.origen.lat), Number(points.origen.lng)],
      [Number(points.destino.lat), Number(points.destino.lng)]
    ], {
      tipo: "AUTOMATICA",
      origen: points.origen,
      destino: points.destino
    });
  }

  // Recalcula la ruta pasando por los puntos de ajuste, igual que un
  // planificador de carretera: el usuario mueve un punto y el motor vuelve
  // a buscar el camino por carretera entre los anclajes.
  async function requestOsrmRouteThroughAnchors(anchors, meta = {}) {
    const clean = (anchors || []).map(p => [Number(p[0]), Number(p[1])])
      .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (clean.length < 2) throw new Error("SE NECESITAN AL MENOS DOS PUNTOS.");

    const url = `https://router.project-osrm.org/route/v1/driving/${clean.map(p => `${p[1]},${p[0]}`).join(";")}?overview=full&geometries=geojson&steps=false`; 
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("EL SERVICIO DE RUTA NO RESPONDIÓ.");
    const data = await response.json();
    const route = data.routes?.[0];
    if (data.code !== "Ok" || !route?.geometry?.coordinates?.length) {
      throw new Error("NO SE ENCONTRÓ UNA RUTA POR CARRETERA.");
    }

    const snappedAnchors = (data.waypoints || []).map(w => {
      const c = w?.location;
      return Array.isArray(c) && c.length >= 2 ? [Number(c[1]), Number(c[0])] : null;
    }).filter(Boolean);

    return {
      tipo: meta.tipo || "AUTOMATICA",
      geometria: route.geometry,
      distancia_km: Number(route.distance || 0) / 1000,
      duracion_min: Number(route.duration || 0) / 60,
      fuente: meta.fuente || "OSRM_CARRETERA",
      anclajes: snappedAnchors.length >= 2 ? snappedAnchors : clean
    };
  }

  function routeEndsNearGeofence(route, zone) {
    if (!zone || !route?.geometria) return true;
    const pts = geometryToLatLngs(route.geometria);
    if (pts.length < 2) return false;
    const last = pts[pts.length - 1];
    const lat = Number(zone.lat), lng = Number(zone.lng);
    if (![last[0], last[1], lat, lng].every(Number.isFinite)) return false;
    const R = 6371000;
    const p1 = last[0] * Math.PI / 180, p2 = lat * Math.PI / 180;
    const dLat = (lat - last[0]) * Math.PI / 180, dLng = (lng - last[1]) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
    const distance = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    return distance <= Math.max(1000, Number(zone.radio_metros || 300) + 1000);
  }

  function captureMapView() {
    if (!map) return null;
    try {
      const center = map.getCenter();
      const zoom = map.getZoom();
      if (!center || !Number.isFinite(zoom)) return null;
      return { lat: center.lat, lng: center.lng, zoom };
    } catch (_) {
      return null;
    }
  }

  function restoreMapView(view) {
    if (!map || !view) return;
    try {
      map.setView([view.lat, view.lng], view.zoom, { animate: false });
    } catch (_) {}
  }

  function drawRoute(route, points, sourceLabel = "CARRETERA", preserveView = false) {
    const latlngs = geometryToLatLngs(route?.geometria);
    if (latlngs.length < 2) throw new Error("EL TRAZO RECIBIDO NO TIENE SUFICIENTES PUNTOS.");

    ensureMap(true);
    plannedLine.setLatLngs(latlngs);
    plannedLine.setStyle({ color: ORANGE, weight: 8, opacity: 1, dashArray: null });
    plannedLine.bringToFront();

    markers.clearLayers();
    // Las geocercas ya cargadas permanecen visibles; el sistema solo resalta
    // visualmente origen/destino sin borrar las demás.
    drawAllGeofences();
    addMarker(points.origen, "ORIGEN");
    addMarker(points.destino, "DESTINO");

    currentTrace = {
      ...route,
      puntos: latlngs,
      geometry: route.geometria,
      fuente: sourceLabel,
      origen_lat: points.origen.lat,
      origen_lng: points.origen.lng,
      destino_lat: points.destino.lat,
      destino_lng: points.destino.lng
    };

    if (!preserveView) {
      try {
        map.fitBounds(plannedLine.getBounds(), { padding: [45, 45], maxZoom: 13, animate: false });
      } catch (_) {}
    }
    repair();
    updateData(latlngs);
    return latlngs;
  }

  async function buildAutomaticRoute() {
    manualMode = false;
    manualRouteContext = null;
    manualRequestToken++;
    clearManualAnchor();
    $("btnRutaManual")?.classList.remove("is-active");
    $("btnTerminarTrazo")?.classList.remove("is-active");
    const button = $("btnRutaAutomatica");
    if (button) button.disabled = true;

    try {
      const points = await getRoutePoints();
      if (!points) return;

      ensureMap(true);
      const hadRouteBeforeRegenerate = Boolean(plannedLine?.getLatLngs?.().length >= 2 || currentTrace?.geometry);
      const savedMapView = hadRouteBeforeRegenerate ? captureMapView() : null;
      clearLayersOnly();
      setStatus("CALCULANDO RECORRIDO POR CARRETERA…");

      /*
         PASO CRÍTICO V74:
         OSRM se dibuja primero. La consulta Samsara nunca puede impedir
         que el usuario vea la línea naranja.
      */
      const roadRoute = await requestOsrmRoute(points);
      drawRoute(roadRoute, points, "OSRM", Boolean(savedMapView));
      if (points.origenGeocerca) drawGeofence(points.origenGeocerca, false);
      if (points.geocerca) {
        currentTrace.geocerca_id = points.geocerca.id || null;
        currentTrace.geocerca_nombre = points.geocerca.nombre || null;
        currentTrace.geocerca_lat = Number(points.geocerca.lat);
        currentTrace.geocerca_lng = Number(points.geocerca.lng);
        currentTrace.geocerca_radio_metros = Number(points.geocerca.radio_metros || 300);
        drawGeofence(points.geocerca, false);
      }
      setStatus(`🟠 RUTA VISIBLE · ${roadRoute.distancia_km.toFixed(1)} KM · ${Math.round(roadRoute.duracion_min)} MIN.`);

      /*
         En segundo plano intentamos mejorarla con la ruta guardada,
         histórica Samsara y geocerca. Si falla, conservamos OSRM.
      */
      let intelligent = null;
      try {
        if (window.SMTRutaInteligente?.prepareRoute) {
          setStatus("🟠 RUTA VISIBLE · CONSULTANDO RUTA GUARDADA / SAMSARA…");
          intelligent = await window.SMTRutaInteligente.prepareRoute({
            eco: $("eco")?.value.trim() || null,
            origen: points.origenText,
            destino: points.destinoText,
            municipio: points.municipio,
            originPoint: points.origen,
            destinationPoint: points.destino,
            onStatus: msg => setStatus(`🟠 RUTA VISIBLE · ${String(msg).replace(/^🟠\s*/, "")}`)
          });
        }
      } catch (error) {
        console.warn("Ruta inteligente opcional:", error);
      }

      if (intelligent?.route?.geometria) {
        try {
          const learnedPoints = geometryToLatLngs(intelligent.route.geometria);
          const routeZone = intelligent.geofence || points.geocerca || null;
          if (learnedPoints.length >= 2 && routeEndsNearGeofence(intelligent.route, routeZone)) {
            const learned = { ...intelligent.route };
            drawRoute(learned, points, intelligent.source === "SAMSARA_APRENDIDA" ? "SAMSARA" : (learned.fuente || "GUARDADA"), Boolean(savedMapView));
            currentTrace.muestras = learned.muestras || null;
            currentTrace.confianza = learned.confianza || null;
            currentTrace.geocerca_id = routeZone?.id || null;
            currentTrace.geocerca_nombre = routeZone?.nombre || null;
            currentTrace.geocerca_lat = routeZone?.lat || null;
            currentTrace.geocerca_lng = routeZone?.lng || null;
            currentTrace.geocerca_radio_metros = routeZone?.radio_metros || null;
            currentTrace.desviacion_metros = 1000;
            if (routeZone) drawGeofence(routeZone);
            setStatus(`🟠 RUTA VISIBLE · ${currentTrace.fuente === "SAMSARA" ? "APRENDIDA CON SAMSARA" : "GUARDADA"}${currentTrace.muestras ? ` · ${currentTrace.muestras} HISTÓRICOS` : ""}.`);
          } else {
            if (routeZone) drawGeofence(routeZone);
            setStatus("🟠 RUTA VISIBLE · SE CONSERVÓ LA RUTA POR CARRETERA HASTA LA GEOCERCA.");
          }
        } catch (error) {
          console.warn("No se pudo dibujar ruta inteligente; se conserva OSRM:", error);
        }
      } else if (intelligent?.geofence || points.geocerca) {
        drawGeofence(intelligent?.geofence || points.geocerca);
        setStatus(`🟠 RUTA VISIBLE · CARRETERA · 🟢 GEOCERCA DESTINO.`);
      }
    } catch (error) {
      console.error("Ruta automática:", error);
      setStatus(error.message || "NO SE PUDO CREAR LA RUTA.", true);
    } finally {
      if (button) button.disabled = false;
      if (savedMapView) restoreMapView(savedMapView);
      repair();
    }
  }

  function clearEditHandles() {
    editHandles.forEach(h => { try { map?.removeLayer(h); } catch (_) {} });
    editHandles = [];
  }

  function buildEditAnchors() {
    const pts = plannedLine?.getLatLngs() || [];
    if (pts.length < 2) return [];
    const count = Math.min(20, Math.max(8, Math.round(pts.length / 18)));
    const anchors = [];
    for (let i = 0; i < count; i++) {
      const index = Math.round((pts.length - 1) * (i / (count - 1)));
      anchors.push([pts[index].lat, pts[index].lng]);
    }
    return anchors;
  }

  function renderEditHandles() {
    clearEditHandles();
    if (!editMode || !map || editAnchors.length < 2) return;
    editAnchors.forEach((anchor, index) => {
      const marker = L.marker(anchor, {
        draggable: true,
        zIndexOffset: 2000,
        icon: L.divIcon({ className: "ruta-edit-handle-wrap", html: "<span class=\"ruta-edit-handle\"></span>", iconSize: [18,18], iconAnchor: [9,9] })
      }).addTo(map);
      marker._routeIndex = index;

      marker.on("dragstart", () => {
        // La línea anterior se quita mientras se mueve el punto. Al soltar,
        // se reconstruye completa sobre carretera usando todos los anclajes.
        plannedLine.setStyle({ opacity: 0 });
        setStatus("AJUSTANDO RECORRIDO A CARRETERA…");
      });

      marker.on("dragend", async e => {
        const p = e.target.getLatLng();
        const savedMapView = captureMapView();
        editAnchors[index] = [p.lat, p.lng];
        const token = ++editRequestToken;
        try {
          setStatus("RECALCULANDO RUTA POR CARRETERA…");
          const rerouted = await requestOsrmRouteThroughAnchors(editAnchors, {
            tipo: "AUTOMATICA",
            fuente: "RUTA_AJUSTADA_CARRETERA"
          });
          if (token !== editRequestToken) return;
          if (rerouted.anclajes?.length >= 2) editAnchors = rerouted.anclajes;
          const points = {
            origen: { lat: editAnchors[0][0], lng: editAnchors[0][1] },
            destino: { lat: editAnchors[editAnchors.length - 1][0], lng: editAnchors[editAnchors.length - 1][1] }
          };
          drawRoute(rerouted, points, "RUTA_AJUSTADA_CARRETERA", true);
          restoreMapView(savedMapView);
          currentTrace.fuente = "RUTA_AJUSTADA_CARRETERA";
          currentTrace.anclajes = editAnchors.map(p => [p[0], p[1]]);
          if (editMode) renderEditHandles();
          setStatus("🟠 RUTA REACOMODADA · MUEVE OTRO PUNTO O GUARDA LOS CAMBIOS.");
        } catch (error) {
          plannedLine.setStyle({ opacity: 1 });
          if (editMode) renderEditHandles();
          setStatus(error.message || "NO SE PUDO REACOMODAR LA RUTA.", true);
        }
      });
      editHandles.push(marker);
    });
  }

  function toggleEditMode() {
    if (!plannedLine || plannedLine.getLatLngs().length < 2) {
      setStatus("PRIMERO CREA O CARGA UNA RUTA AUTOMÁTICA.", true);
      return;
    }
    editMode = !editMode;
    const btn = $("btnAjustarTrazo");
    if (btn) {
      btn.classList.toggle("is-active", editMode);
      btn.textContent = editMode ? "✓" : "✥";
      btn.setAttribute("aria-label", editMode ? "Terminar ajuste" : "Ajustar trazo");
      btn.title = editMode ? "Terminar ajuste" : "Ajustar trazo";
    }
    if (editMode) {
      editAnchors = buildEditAnchors();
      renderEditHandles();
      setStatus("AJUSTE DE RUTA · MUEVE LOS PUNTOS NARANJA; LA RUTA SE ACOMODARÁ A LA CARRETERA.");
    } else {
      clearEditHandles();
      plannedLine.setStyle({ opacity: 1 });
      setStatus("AJUSTE TERMINADO · GUARDA LA RUTA PARA CONSERVAR LOS CAMBIOS.");
    }
  }

  async function startManual() {
    const button = $("btnRutaManual");
    if (button) button.disabled = true;
    try {
      const points = await getRoutePoints();
      if (!points) return;
      ensureMap(true);
      const hadRouteBeforeManual = Boolean(plannedLine?.getLatLngs?.().length >= 2 || currentTrace?.geometry);
      const savedMapView = hadRouteBeforeManual ? captureMapView() : null;
      clearLayersOnly();
      manualRequestToken++;
      manualRouteContext = points;
      manualAnchorMarker = null;
      manualMode = true;
      $("btnRutaManual")?.classList.add("is-active");
      $("btnTerminarTrazo")?.classList.add("is-active");
      drawAllGeofences();
      setStatus("MODO MANUAL · COLOCA UN SOLO PUNTO SOBRE EL MAPA.");
      if (!savedMapView) {
        try {
          const bounds = L.latLngBounds([[points.origen.lat, points.origen.lng], [points.destino.lat, points.destino.lng]]);
          map.fitBounds(bounds, { padding: [55, 55], maxZoom: 10, animate: false });
        } catch (_) {}
      } else {
        restoreMapView(savedMapView);
      }
    } catch (error) {
      console.error("Ruta manual:", error);
      setStatus(error.message || "NO SE PUDO PREPARAR EL TRAZO MANUAL.", true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function createManualAnchor(latlng) {
    if (!manualMode || !manualRouteContext || !latlng) return;
    ensureMap(true);
    clearManualAnchor();
    manualAnchorMarker = L.marker(latlng, {
      draggable: true,
      zIndexOffset: 2200,
      icon: L.divIcon({ className: "ruta-manual-anchor-wrap", html: '<span class="ruta-manual-anchor"></span>', iconSize: [22,22], iconAnchor: [11,11] })
    }).addTo(map);
    manualAnchorMarker.bindTooltip("PUNTO DE AJUSTE", { direction: "top", offset: [0, -10] });
    manualAnchorMarker.on("dragend", () => rebuildManualRoute(manualAnchorMarker.getLatLng()));
    await rebuildManualRoute(latlng);
  }

  async function rebuildManualRoute(anchor) {
    if (!manualRouteContext || !anchor) return;
    const token = ++manualRequestToken;
    try {
      setStatus("🟠 TRAZANDO RUTA MANUAL POR CARRETERA…");
      const route = await requestOsrmRouteThroughAnchors([
        [manualRouteContext.origen.lat, manualRouteContext.origen.lng],
        [anchor.lat, anchor.lng],
        [manualRouteContext.destino.lat, manualRouteContext.destino.lng]
      ], { tipo: "MANUAL", fuente: "MANUAL_PUNTO_CARRETERA" });
      if (token !== manualRequestToken) return;
      drawRoute(route, manualRouteContext, "MANUAL_PUNTO_CARRETERA");
      currentTrace.tipo = "MANUAL";
      currentTrace.fuente = "MANUAL_PUNTO_CARRETERA";
      currentTrace.punto_ajuste = [Number(anchor.lat), Number(anchor.lng)];
      currentTrace.desviacion_metros = 1000;
      // drawRoute limpia los marcadores; se vuelve a colocar únicamente el punto manual.
      manualAnchorMarker = L.marker(anchor, {
        draggable: true,
        zIndexOffset: 2200,
        icon: L.divIcon({ className: "ruta-manual-anchor-wrap", html: '<span class="ruta-manual-anchor"></span>', iconSize: [22,22], iconAnchor: [11,11] })
      }).addTo(map);
      manualAnchorMarker.bindTooltip("PUNTO DE AJUSTE", { direction: "top", offset: [0, -10] });
      manualAnchorMarker.on("dragend", () => rebuildManualRoute(manualAnchorMarker.getLatLng()));
      setStatus("🟠 RUTA MANUAL VISIBLE · MUEVE EL ÚNICO PUNTO O GUARDA.");
    } catch (error) {
      console.warn("Ruta manual por carretera:", error);
      setStatus(error.message || "NO SE PUDO TRAZAR LA RUTA MANUAL.", true);
    }
  }

  function clearManualAnchor() {
    if (manualAnchorMarker) {
      try { map?.removeLayer(manualAnchorMarker); } catch (_) {}
      manualAnchorMarker = null;
    }
  }

  function finishManual() {
    if (!currentTrace?.geometry || currentTrace.tipo !== "MANUAL") {
      setStatus("COLOCA EL ÚNICO PUNTO PARA GENERAR LA RUTA MANUAL.", true);
      return;
    }
    manualMode = false;
    manualRouteContext = null;
    $("btnRutaManual")?.classList.remove("is-active");
    $("btnTerminarTrazo")?.classList.remove("is-active");
    setStatus("🟠 RUTA MANUAL TERMINADA · LISTA PARA GUARDAR.");
    repair();
  }

  function clearAll() {
    const savedMapView = captureMapView();
    manualMode = false;
    manualRouteContext = null;
    manualRequestToken++;
    clearManualAnchor();
    editMode = false;
    editAnchors = [];
    editRequestToken++;
    clearEditHandles();
    const editButton = $("btnAjustarTrazo");
    if (editButton) { editButton.classList.remove("is-active"); editButton.textContent = "✥"; editButton.setAttribute("aria-label","Ajustar trazo"); editButton.title="Ajustar trazo"; }
    currentTrace = null;
    clearLayersOnly();
    restoreMapView(savedMapView);
    $("btnRutaManual")?.classList.remove("is-active");
    $("btnTerminarTrazo")?.classList.remove("is-active");
    updateData([]);
    setStatus("MAPA LIMPIO · LISTO PARA CREAR UNA RUTA.");
    repair();
  }

  function clearLayersOnly() {
    clearManualAnchor();
    plannedLine?.setLatLngs([]);
    manualLine?.setLatLngs([]).setStyle({ dashArray: "10 8", color: ORANGE, weight: 8, opacity: 1 });
    markers?.clearLayers();
    // Las geocercas permanecen visibles al limpiar; solo se elimina el trazo.
  }

  function addMarker(point, label) {
    L.circleMarker([point.lat, point.lng], {
      radius: 6,
      color: ORANGE,
      weight: 3,
      fillColor: "#fff",
      fillOpacity: 1,
      interactive: false
    }).addTo(markers);
  }

  function drawGeofence(zone, clear = false) {
    if (!zone || !Number.isFinite(Number(zone.lat)) || !Number.isFinite(Number(zone.lng))) return;
    if (clear) geofenceLayer?.clearLayers();
    const radius = Math.max(30, Number(zone.radio_metros || 300));
    L.circle([Number(zone.lat), Number(zone.lng)], {
      radius,
      color: "#16A34A",
      weight: 1.5,
      fillColor: "#16A34A",
      fillOpacity: 0.08,
      interactive: false
    }).addTo(geofenceLayer);
  }

  async function loadMunicipalities() {
    const destination = $("destino")?.value.trim();
    const input = $("municipio");
    const box = $("sugerenciasMunicipioViaje");
    if (!destination || !input || !box) return;

    const query = `${input.value.trim() || "municipio"}, ${destination}, Mexico`;
    if (query === lastMunicipalityQuery) return;
    lastMunicipalityQuery = query;

    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=10&countrycodes=mx&q=${encodeURIComponent(query)}`);
      if (!response.ok) return;
      const rows = await response.json();
      const list = rows.slice(0, 8);
      if (!list.length) { box.hidden = true; return; }
      box.innerHTML = list.map(row => {
        const a = row.address || {};
        const name = a.municipality || a.town || a.city || a.village || row.name || row.display_name.split(",")[0];
        const state = a.state || destination;
        return `<button type="button" class="smart-suggestion" data-name="${esc(name)}"><span><strong>${esc(name)}</strong><small>${esc(state)}</small></span></button>`;
      }).join("");
      box.hidden = false;
    } catch (e) {
      console.warn("Municipios:", e);
    }
  }

  async function loadSavedRoute() {
    const key = routeKey();
    if (!key || manualMode) return;

    let row = null;
    try {
      if (window.supabaseClient) {
        const r = await window.supabaseClient.from(TABLE).select("*").eq("clave", key).maybeSingle();
        if (!r?.error) row = r?.data || null;
      }
    } catch (_) {}

    if (!row) row = readLocal()[key];
    if (!row?.geometria) return;

    const points = geometryToLatLngs(row.geometria);
    if (points.length < 2) return;
    ensureMap(true);
    clearLayersOnly();
    plannedLine.setLatLngs(points).setStyle({ color: ORANGE, weight: 8, opacity: 1, dashArray: null }).bringToFront();
    currentTrace = {
      ...row,
      tipo: row.tipo || "AUTOMATICA",
      geometry: row.geometria,
      puntos: points,
      fuente: row.fuente || "GUARDADA",
      desviacion_metros: row.desviacion_metros || 1000
    };
    try { map.fitBounds(plannedLine.getBounds(), { padding: [40, 40], maxZoom: 13, animate: false }); } catch (_) {}
    updateData(points);
    setStatus("🟠 RUTA GUARDADA CARGADA Y VISIBLE.");
    repair();
  }

  function recoverTraceFromVisibleRoute() {
    // REGLA V89: la geometría que está dibujada en el mapa es la fuente de
    // verdad. Nunca devolvemos primero currentTrace porque podría contener
    // una versión anterior al último ajuste manual. Esto garantiza que, al
    // pulsar GUARDAR, se persista exactamente la ruta que el operador dejó
    // visible después de editarla.
    const linePoints = plannedLine?.getLatLngs?.() || [];
    const latlngs = linePoints
      .map(p => [Number(p.lat), Number(p.lng)])
      .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));

    if (latlngs.length < 2) {
      return currentTrace?.geometry ? currentTrace : null;
    }

    const coordinates = latlngs.map(p => [p[1], p[0]]);
    const previous = currentTrace || {};
    const tipo = previous.tipo || (manualAnchorMarker ? "MANUAL" : "AUTOMATICA");
    const fuente = previous.fuente || (manualAnchorMarker ? "MANUAL_PUNTO_CARRETERA" : "RUTA_VISIBLE");

    currentTrace = {
      ...previous,
      tipo,
      geometry: { type: "LineString", coordinates },
      puntos: latlngs,
      fuente,
      distancia_km: calcularDistanciaRutaKm(latlngs),
      desviacion_metros: previous.desviacion_metros || 1000,
      anclajes: editAnchors.length >= 2
        ? editAnchors.map(p => [Number(p[0]), Number(p[1])])
        : previous.anclajes
    };

    return currentTrace;
  }

  function calcularDistanciaRutaKm(points) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const R = 6371;
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const lat1 = Number(a[0]) * Math.PI / 180;
      const lat2 = Number(b[0]) * Math.PI / 180;
      const dLat = (Number(b[0]) - Number(a[0])) * Math.PI / 180;
      const dLng = (Number(b[1]) - Number(a[1])) * Math.PI / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
      total += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    return total;
  }

  let pendingSaveTrace = null;

  async function openSaveRegistration(trace) {
    // Tomar una instantánea nueva de la línea visible justo al abrir el registro.
    // Así pendingSaveTrace nunca queda apuntando a una geometría anterior.
    pendingSaveTrace = recoverTraceFromVisibleRoute() || trace;
    const modal = $("modalRegistroRuta");
    if (!modal) return;
    const sourceOrigin = routeValue("origen");
    const sourceDest = routeValue("destino");
    const sourceMunicipio = routeValue("municipio");
    $("registroRutaOrigen").value = upperRouteValue(sourceOrigin);
    $("registroRutaDestino").value = upperRouteValue(sourceDest);
    $("registroRutaMunicipio").value = upperRouteValue(sourceMunicipio);
    await populateRouteRegistrationLists();
    setSaveRegistrationStatus("LOS TRES DATOS SON OBLIGATORIOS.");
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => $("registroRutaOrigen")?.focus(), 60);
  }

  function closeSaveRegistration() {
    const modal = $("modalRegistroRuta");
    if (modal) {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
    }
    pendingSaveTrace = null;
  }

  function setSaveRegistrationStatus(message, error = false) {
    const el = $("registroRutaEstado");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", !!error);
  }

  function clearRouteRegistrationFields() {
    ["rutaOrigen","rutaDestino","rutaMunicipio"].forEach(id => {
      const el = $(id);
      if (el) el.value = "";
    });
    setStatus("MAPA LIMPIO · LISTO PARA CREAR UNA RUTA.");
    updateData([]);
    loadSavedRoute();
  }

  function normalizeRouteText(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/\s+/g, " ").trim();
  }

  // V90: la información operativa de ruta siempre se presenta y persiste
  // en MAYÚSCULAS. Se conservan acentos en el texto visible/guardado; la
  // normalización sin acentos se utiliza únicamente para claves de búsqueda.
  function upperRouteValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleUpperCase("es-MX");
  }

  function enforceUpperRouteField(id, live = false) {
    const el = $(id);
    if (!el) return;
    // En escritura no hacemos trim/collapse: así el usuario puede teclear
    // espacios normalmente (por ejemplo: "UNIDAD HABITACIONAL").
    const raw = String(el.value || "");
    const next = live
      ? raw.toLocaleUpperCase("es-MX")
      : upperRouteValue(raw);
    if (el.value !== next) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.value = next;
      if (live && Number.isInteger(start) && Number.isInteger(end)) {
        try { el.setSelectionRange(start, end); } catch (_) {}
      }
    }
  }

  function uniqueSorted(values) {
    return [...new Set(values.map(v => String(v || "").trim()).filter(Boolean))]
      .sort((a,b) => a.localeCompare(b, "es", { sensitivity: "base" }));
  }

  async function getExistingSavedRoutes() {
    let data = [];
    try {
      if (window.supabaseClient) {
        const r = await window.supabaseClient.from(TABLE).select("id,clave,origen,destino,municipio").order("actualizado_at", { ascending: false });
        if (!r.error && Array.isArray(r.data)) data = r.data;
      }
    } catch (_) {}
    if (!data.length) {
      try { data = Object.values(readLocal()); } catch (_) {}
    }
    return Array.isArray(data) ? data : [];
  }

  async function populateRouteRegistrationLists() {
    const rows = await getExistingSavedRoutes();
    const origins = uniqueSorted(rows.map(r => r.origen));
    const destinations = uniqueSorted(rows.map(r => r.destino));
    const municipalities = uniqueSorted(rows.map(r => r.municipio));

    const fill = (id, values) => {
      const el = $(id);
      if (!el) return;
      el.innerHTML = values.map(v => `<option value="${esc(v)}"></option>`).join("");
    };
    fill("listaRegistroRutaOrigenes", origins);
    fill("listaRegistroRutaDestinos", destinations);
    fill("listaRegistroRutaMunicipios", municipalities);
  }

  async function confirmSaveRegistration() {
    // La línea visible manda hasta el último segundo antes de guardar.
    const trace = recoverTraceFromVisibleRoute() || pendingSaveTrace;
    const origen = upperRouteValue($("registroRutaOrigen")?.value);
    const destino = upperRouteValue($("registroRutaDestino")?.value);
    const municipio = upperRouteValue($("registroRutaMunicipio")?.value);
    if ($("registroRutaOrigen")) $("registroRutaOrigen").value = origen;
    if ($("registroRutaDestino")) $("registroRutaDestino").value = destino;
    if ($("registroRutaMunicipio")) $("registroRutaMunicipio").value = municipio;

    if (!trace?.geometry) {
      setSaveRegistrationStatus("NO HAY UN TRAZO VÁLIDO PARA GUARDAR.", true);
      return;
    }
    if (!origen || !destino || !municipio) {
      setSaveRegistrationStatus("ORIGEN, DESTINO Y MUNICIPIO / ALCALDÍA SON OBLIGATORIOS.", true);
      return;
    }

    const key = `${normalizeRouteText(origen)}__${normalizeRouteText(destino)}__${normalizeRouteText(municipio)}`;
    const payload = {
      clave: key,
      origen,
      destino,
      municipio,
      tipo: trace.tipo || "AUTOMATICA",
      geometria: trace.geometry,
      distancia_km: trace.distancia_km || null,
      duracion_min: trace.duracion_min || null,
      fuente: trace.fuente || "MANUAL",
      muestras: trace.muestras || null,
      confianza: trace.confianza || null,
      geocerca_id: trace.geocerca_id || null,
      geocerca_nombre: trace.geocerca_nombre || null,
      geocerca_lat: trace.geocerca_lat || null,
      geocerca_lng: trace.geocerca_lng || null,
      geocerca_radio_metros: trace.geocerca_radio_metros || null,
      desviacion_metros: trace.desviacion_metros || 1000,
      actualizado_at: new Date().toISOString()
    };

    setSaveRegistrationStatus("GUARDANDO RUTA…");
    writeLocal(key, payload);

    try {
      if (!window.supabaseClient) throw new Error("SUPABASE NO DISPONIBLE");
      const result = await window.supabaseClient.from(TABLE).upsert(payload, { onConflict: "clave" });
      if (result.error) throw result.error;
      setStatus("🟠 RUTA GUARDADA · LISTA PARA REUTILIZARSE.");
      closeSaveRegistration();
      clearRouteFieldsAfterSave();
    } catch (e) {
      console.warn("Guardado Supabase:", e);
      setSaveRegistrationStatus("SE GUARDÓ LOCALMENTE, PERO SUPABASE NO CONFIRMÓ EL GUARDADO.", true);
      setStatus("🟠 RUTA GUARDADA LOCALMENTE · SUPABASE NO DISPONIBLE.", true);
    }
  }

  function clearRouteFieldsAfterSave() {
    ["rutaOrigen","rutaDestino","rutaMunicipio"].forEach(id => {
      const el = $(id);
      if (el) el.value = "";
    });
    // El trazo queda visible para que el operador vea qué acaba de guardar.
    updateData(currentTrace?.puntos || geometryToLatLngs(currentTrace?.geometry));
  }

  async function saveCurrent() {
    const trace = recoverTraceFromVisibleRoute();
    if (!trace?.geometry) {
      setStatus("NO HAY UN TRAZO VÁLIDO PARA GUARDAR.", true);
      return;
    }
    await openSaveRegistration(trace);
  }

  function geometryToLatLngs(g) {
    if (!g) return [];
    if (g.type === "LineString" && Array.isArray(g.coordinates)) {
      return g.coordinates
        .map(p => [Number(p[1]), Number(p[0])])
        .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    }
    if (g.type === "Feature" && g.geometry) return geometryToLatLngs(g.geometry);
    return [];
  }

  function routeKey() {
    const n = v => String(v || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/\s+/g, " ").trim();
    const o = n(routeValue("origen"));
    const d = n(routeValue("destino"));
    const m = n(routeValue("municipio"));
    return o && d ? `${o}__${d}__${m}` : "";
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}"); } catch (_) { return {}; }
  }

  function writeLocal(k, v) {
    try {
      const d = readLocal();
      d[k] = v;
      localStorage.setItem(LOCAL_KEY, JSON.stringify(d));
    } catch (_) {}
  }

  function updateData(points) {
    const box = $("rutaPlannerDatos");
    if (!box) return;
    if (!points.length) { box.innerHTML = ""; updateAccessCard(); return; }
    const c = currentTrace || {};
    box.innerHTML =
      `<span style="color:${ORANGE}">● RUTA NARANJA</span>` +
      `<span>FUENTE: <b>${esc(c.fuente || c.tipo || "RUTA")}</b></span>` +
      `<span>PUNTOS: <b>${points.length}</b></span>` +
      (c.distancia_km ? `<span>DISTANCIA: <b>${Number(c.distancia_km).toFixed(1)} KM</b></span>` : "") +
      (c.muestras ? `<span>HISTÓRICOS: <b>${Number(c.muestras)}</b></span>` : "");
    updateAccessCard();
  }

  function setStatus(msg, error = false) {
    const el = $("rutaPlannerEstado");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!error);
  }

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
  }

  let previewMap = null;
  let previewLine = null;
  let previewToken = 0;

  async function previewNewTripRoute() {
    const box = $("nuevoViajeRutaPreview");
    const mapEl = $("nuevoViajeRutaPreviewMap");
    if (!box || !mapEl) return;
    const o = String($("origen")?.value || "").trim();
    const d = String($("destino")?.value || "").trim();
    const m = String($("municipio")?.value || "").trim();
    if (!o || !d) { box.hidden = true; return; }
    const n = v => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g," ").trim();
    const key = `${n(o)}__${n(d)}__${n(m)}`;
    const token = ++previewToken;
    let row = null;
    try {
      if (window.supabaseClient) {
        const r = await window.supabaseClient.from(TABLE).select("*").eq("clave", key).maybeSingle();
        if (!r.error) row = r.data || null;
        if (!row && !m) {
          const r2 = await window.supabaseClient.from(TABLE).select("*").eq("origen", o).eq("destino", d).is("municipio", null).maybeSingle();
          if (!r2.error) row = r2.data || null;
        }
      }
    } catch (_) {}
    if (!row) {
      try {
        const local = readLocal();
        row = local[key] || null;
        if (!row) {
          const prefix = `${n(o)}__${n(d)}__`;
          const found = Object.entries(local).find(([k]) => k.startsWith(prefix));
          row = found?.[1] || null;
        }
      } catch (_) {}
    }
    if (token !== previewToken) return;
    const points = geometryToLatLngs(row?.geometria);
    if (points.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    const status = $("nuevoViajeRutaPreviewEstado");
    if (status) status.textContent = "RUTA CARGADA · LISTA PARA SEGUIMIENTO";
    if (!window.L) return;
    if (!previewMap) {
      previewMap = L.map(mapEl, { zoomControl:false, attributionControl:true, dragging:false, scrollWheelZoom:false, doubleClickZoom:false, boxZoom:false, keyboard:false, touchZoom:false, zoomSnap:1 }).setView(points[0], 8);
      // V90: no usar tiles públicos de OpenStreetMap en este mapa. Esa capa
      // provocaba el 403 "ACCESS BLOCKED / TILE USAGE POLICY" en NUEVO VIAJE.
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
        maxZoom:19, maxNativeZoom:19, attribution:"Mapa © Esri"
      }).addTo(previewMap);
      previewLine = L.polyline([], { color: ORANGE, weight:4, opacity:.95, interactive:false }).addTo(previewMap);
    }
    previewLine.setLatLngs(points);
    try { previewMap.fitBounds(previewLine.getBounds(), {padding:[12,12], maxZoom:11, animate:false}); } catch (_) {}
    setTimeout(() => previewMap?.invalidateSize(), 60);
  }

  async function asignarRutaGuardadaAViaje(viaje){
    if(!viaje?.id_viaje || !window.supabaseClient) return false;
    const o=upperRouteValue(viaje.origen), d=upperRouteValue(viaje.destino), m=upperRouteValue(viaje.municipio);
    if(!o || !d) return false;
    let row=null;
    const key=routeKeyFromValues(o,d,m);
    try{
      if(key){
        const r=await window.supabaseClient.from(TABLE).select('*').eq('clave',key).maybeSingle();
        if(!r.error) row=r.data||null;
      }
      if(!row && !m){
        const r=await window.supabaseClient.from(TABLE).select('*').eq('origen',o).eq('destino',d).order('actualizado_at',{ascending:false}).limit(1).maybeSingle();
        if(!r.error) row=r.data||null;
      }
      if(row?.geometria){
        const payload={id_viaje:String(viaje.id_viaje),clave:row.clave,tipo:row.tipo||'AUTOMATICA',geometria:row.geometria,distancia_km:row.distancia_km||null,duracion_min:row.duracion_min||null,fuente:row.fuente||'RUTA_TRAZADA',desviacion_metros:row.desviacion_metros||1000,creado_at:new Date().toISOString()};
        const up=await window.supabaseClient.from('viaje_ruta_trazos').upsert(payload,{onConflict:'id_viaje'});
        if(up.error) throw up.error;
        return true;
      }
      // Si se cambió la ruta y no existe un trazado compatible, no dejamos
      // al viaje siguiendo accidentalmente el trazado anterior.
      await window.supabaseClient.from('viaje_ruta_trazos').delete().eq('id_viaje',String(viaje.id_viaje));
    }catch(e){console.warn('Asignación de ruta al viaje:',e);}
    return false;
  }

  function routeKeyFromValues(origen,destino,municipio){
    const n=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
    const o=n(origen),d=n(destino),m=n(municipio);
    return o&&d?`${o}__${d}__${m}`:'';
  }

  window.SMTRutaPlanner = {
    getTrace: () => currentTrace,
    open: openPlannerModal,
    previewNewTripRoute,
    getKey: routeKey,
    asignarRutaGuardadaAViaje,
    async guardarVinculoViaje(idViaje) {
      if (!currentTrace || !idViaje || !window.supabaseClient) return;
      const key = routeKey();
      if (!key) return;
      const payload = {
        id_viaje: String(idViaje),
        clave: key,
        tipo: currentTrace.tipo || "AUTOMATICA",
        geometria: currentTrace.geometry,
        distancia_km: currentTrace.distancia_km || null,
        duracion_min: currentTrace.duracion_min || null,
        fuente: currentTrace.fuente || "MANUAL",
        creado_at: new Date().toISOString()
      };
      try {
        const r = await window.supabaseClient.from("viaje_ruta_trazos").upsert(payload, { onConflict: "id_viaje" });
        if (r.error) console.warn("Vinculación viaje/ruta:", r.error);
      } catch (e) {
        console.warn("Vinculación viaje/ruta:", e);
      }
    }
  };
})();
