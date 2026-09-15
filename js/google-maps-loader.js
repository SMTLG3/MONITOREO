/* V73 — Cargador opcional de Google Maps JavaScript + TrafficLayer */
(function () {
  "use strict";
  window.SMTGoogleMaps = {
    ready: false,
    promise: null,
    async load() {
      if (this.ready && window.google?.maps) return true;
      if (this.promise) return this.promise;
      const key = window.SMT_MAP_CONFIG?.googleMapsApiKey || "";
      if (!key) return false;
      this.promise = new Promise(resolve => {
        const existing = document.getElementById("smt-google-maps-script");
        if (existing) { existing.addEventListener("load", () => { this.ready = true; resolve(true); }, { once: true }); return; }
        const script = document.createElement("script");
        script.id = "smt-google-maps-script";
        script.async = true; script.defer = true;
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
        script.onload = () => { this.ready = true; resolve(true); };
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      });
      return this.promise;
    }
  };
})();
