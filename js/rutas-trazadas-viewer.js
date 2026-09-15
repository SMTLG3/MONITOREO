/* V71 — VISOR FÍSICO DE RUTAS TRAZADAS */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const ORANGE = "#FF8A00";
  let map = null;
  let line = null;
  let geofence = null;
  let rows = [];

  document.addEventListener("DOMContentLoaded", () => {
    $("btnRutasGuardadas")?.addEventListener("click", open);
    $("cerrarRutasTrazadas")?.addEventListener("click", close);
    $("btnVolverAlertasDesdeRutas")?.addEventListener("click", () => { close(); window.SMTAlertasGPS?.open?.(); });
    $("btnCrearRutaTrazada")?.addEventListener("click", () => {
      close();
      window.SMTRutaPlanner?.open?.();
    });
  });

  function initMap() {
    if (map || !window.L) return;
    map = L.map("visorRutaTrazadaMap", { minZoom:3, maxZoom:19 }).setView([23.6345, -102.5528], 5);
    const street=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,maxNativeZoom:19,attribution:"Mapa © Esri"});
    const satellite=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,maxNativeZoom:19,attribution:"Tiles © Esri"});
    const transport=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",{maxZoom:18,maxNativeZoom:18,attribution:"Transporte © Esri"});
    const labels=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",{maxZoom:18,maxNativeZoom:18,attribution:"Lugares © Esri"});
    let mapMode="hybrid"; try{const saved=localStorage.getItem("SMT_SAMSARA_MAP_VIEW");if(saved==="normal"||saved==="hybrid")mapMode=saved;}catch(_){}
    const showBase=()=>{[street,satellite,transport,labels].forEach(layer=>{if(map.hasLayer(layer))map.removeLayer(layer);});if(mapMode==="hybrid"){if(map.getZoom()>18)map.setZoom(18,{animate:false});satellite.addTo(map);transport.addTo(map);labels.addTo(map);}else street.addTo(map);};
    showBase();
    const ctrl=L.control({position:"topright"});ctrl.onAdd=function(){const b=L.DomUtil.create("button","ruta-basemap-toggle");b.type="button";b.classList.toggle("is-satellite",mapMode==="hybrid");b.title=mapMode==="hybrid"?"Vista satelital · cambiar a mapa normal":"Mapa normal · cambiar a vista satelital";b.setAttribute("aria-label",b.title);L.DomEvent.disableClickPropagation(b);L.DomEvent.on(b,"click",()=>{mapMode=mapMode==="hybrid"?"normal":"hybrid";showBase();b.classList.toggle("is-satellite",mapMode==="hybrid");b.title=mapMode==="hybrid"?"Vista satelital · cambiar a mapa normal":"Mapa normal · cambiar a vista satelital";b.setAttribute("aria-label",b.title);try{localStorage.setItem("SMT_SAMSARA_MAP_VIEW",mapMode);}catch(_){}});return b;};ctrl.addTo(map);
    line = L.polyline([], { color: ORANGE, weight: 8, opacity: 1, lineCap: "round", lineJoin: "round" }).addTo(map);
  }

  async function open() {
    const modal = $("modalRutasTrazadas");
    if (!modal) return;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    initMap();
    setTimeout(() => map?.invalidateSize(true), 100);

    try {
      if (!window.supabaseClient) throw new Error("Sin Supabase");
      const result = await supabaseClient.from("rutas_trazadas").select("*").order("actualizado_at", { ascending: false });
      if (result.error) throw result.error;
      rows = result.data || [];
    } catch (_) {
      try { rows = Object.values(JSON.parse(localStorage.getItem("SMT_RUTAS_TRAZADAS_V73") || "{}")); } catch (__) { rows = []; }
    }
    renderList();
  }

  function renderList() {
    const box = $("listaRutasTrazadas");
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state"><strong>NO HAY RUTAS TRAZADAS</strong><br><small>Créala desde RUTAS TRAZADAS → ＋ NUEVA RUTA.</small></div>`;
      line?.setLatLngs([]); geofence?.remove(); geofence = null;
      return;
    }
    box.innerHTML = rows.map((row, index) => `
      <div class="ruta-trazada-item-wrap">
        <button type="button" class="ruta-trazada-item" data-index="${index}">
          <strong>${esc(row.origen)} → ${esc(row.destino)}</strong>
          <small>${esc(row.municipio || "SIN MUNICIPIO")} · ${esc(row.tipo || "AUTOMATICA")}${row.distancia_km ? ` · ${Number(row.distancia_km).toFixed(1)} KM` : ""}</small>
        </button>
        <button type="button" class="ruta-trazada-delete" data-delete-index="${index}" title="Eliminar trazado" aria-label="Eliminar trazado">🗑</button>
      </div>`).join("");
    box.querySelectorAll(".ruta-trazada-item").forEach(button => {
      button.addEventListener("click", () => show(rows[Number(button.dataset.index)], button));
    });
    box.querySelectorAll(".ruta-trazada-delete").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        deleteRoute(rows[Number(button.dataset.deleteIndex)]);
      });
    });
    show(rows[0], box.querySelector(".ruta-trazada-item"));
  }

  function show(row, button) {
    document.querySelectorAll(".ruta-trazada-item").forEach(item => item.classList.remove("is-active"));
    button?.classList.add("is-active");
    const geometry = row?.geometria;
    const coords = geometry?.type === "LineString" ? geometry.coordinates.map(p => [Number(p[1]), Number(p[0])]) : [];
    line?.setLatLngs(coords);
    line?.bringToFront();
    geofence?.remove(); geofence = null;
    if (row?.geocerca_lat && row?.geocerca_lng) { geofence = L.circle([Number(row.geocerca_lat), Number(row.geocerca_lng)], { radius:Number(row.geocerca_radio_metros || 300), color:"#16A34A", weight:2, fillOpacity:.08 }).addTo(map); }
    if (coords.length > 1) {
      try { map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 13 }); } catch (_) {}
    }
  }


  async function deleteRoute(row) {
    if (!row) return;
    const label = `${row.origen || "ORIGEN"} → ${row.destino || "DESTINO"}${row.municipio ? ` · ${row.municipio}` : ""}`;
    if (!window.confirm(`¿BORRAR ESTE TRAZADO?\n\n${label}\n\nEsta acción no se puede deshacer.`)) return;

    let cloudDeleted = false;
    try {
      if (window.supabaseClient && row.id) {
        const result = await window.supabaseClient.from("rutas_trazadas").delete().eq("id", row.id);
        if (result.error) throw result.error;
        cloudDeleted = true;
      }
    } catch (e) {
      console.warn("Eliminación Supabase:", e);
      alert("NO SE PUDO BORRAR LA RUTA EN SUPABASE. VERIFICA LOS PERMISOS RLS.");
      return;
    }

    try {
      const local = JSON.parse(localStorage.getItem("SMT_RUTAS_TRAZADAS_V77") || "{}");
      const key = row.clave || "";
      if (key && local[key]) delete local[key];
      else if (key) {
        Object.keys(local).forEach(k => {
          if (k === key || local[k]?.id === row.id) delete local[k];
        });
      } else if (row.id) {
        Object.keys(local).forEach(k => {
          if (local[k]?.id === row.id) delete local[k];
        });
      }
      localStorage.setItem("SMT_RUTAS_TRAZADAS_V77", JSON.stringify(local));
    } catch (_) {}

    rows = rows.filter(item => {
      if (row.id && item.id) return item.id !== row.id;
      return item !== row;
    });
    renderList();
    if (cloudDeleted) {
      // Mantener la selección limpia cuando se elimina el último elemento.
      line?.bringToFront();
    }
  }

  function close() {
    const modal = $("modalRutasTrazadas");
    if (modal) { modal.style.display = "none"; modal.setAttribute("aria-hidden", "true"); }
  }

  window.SMTRutasTrazadasViewer = { open, close, reload: open };

  function esc(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
})();
