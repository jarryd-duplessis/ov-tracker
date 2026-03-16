import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

const TRANSPORT_COLOURS = {
  BUS: '#4CAF50',
  TRAM: '#FF9800',
  METRO: '#2196F3',
};

const CATEGORY_ICON = { BUS: '🚌', TRAM: '🚊', RAIL: '🚆', SUBWAY: '🚇', FERRY: '⛴️' };

// Returns true if a vehicle matches the tracked departure
function matchesTracked(vehicle, dep) {
  if (!dep) return false;
  if (vehicle.tripId && dep.journeyNumber) {
    if (vehicle.tripId.includes(String(dep.journeyNumber))) return true;
  }
  return vehicle.line === dep.line;
}

export default function Map({ userLocation, nearbyStops, departures, onMapMove, trackedDeparture }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const userMarkerRef = useRef(null);
  const vehicleMarkersRef = useRef([]);
  const hasCenteredRef = useRef(false);
  const moveTimerRef = useRef(null);
  const onMapMoveRef = useRef(onMapMove);
  const trackedDepartureRef = useRef(trackedDeparture);
  const lastTrackedIdRef = useRef(null);
  const renderInViewportRef = useRef(null);
  const [vehicleCount, setVehicleCount] = useState(0);

  // Keep refs current without triggering map re-initialisation
  useEffect(() => { onMapMoveRef.current = onMapMove; }, [onMapMove]);
  useEffect(() => {
    trackedDepartureRef.current = trackedDeparture;
    // Reset so the map pans again when a new departure is selected,
    // then immediately re-render so it pans without waiting for the next poll
    lastTrackedIdRef.current = null;
    renderInViewportRef.current?.();
  }, [trackedDeparture]);

  // Initialise map — empty deps so it never tears down due to prop changes
  useEffect(() => {
    if (mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [4.9, 52.37], // Default: Amsterdam
      zoom: 14,
      attributionControl: true
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right');

    // Watch container size — calls resize() whenever the flex layout gives the
    // container its real pixel dimensions (fixes blank tile loading on mobile)
    const resizeObserver = new ResizeObserver(() => mapRef.current?.resize());
    resizeObserver.observe(mapContainer.current);

    // Fetch stops for whatever area the user pans to (debounced 600ms, zoom >= 13)
    mapRef.current.on('moveend', () => {
      clearTimeout(moveTimerRef.current);
      moveTimerRef.current = setTimeout(() => {
        const map = mapRef.current;
        if (!map || !onMapMoveRef.current) return;
        if (map.getZoom() < 13) return;
        const c = map.getCenter();
        onMapMoveRef.current({ lat: c.lat, lon: c.lng });
      }, 600);
    });

    return () => {
      clearTimeout(moveTimerRef.current);
      resizeObserver.disconnect();
      // Clear marker refs so a remount starts clean (map.remove() destroys them in the DOM)
      markersRef.current = [];
      userMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Centre on user location only on the first fix — never again (avoids snapping on GPS updates)
  useEffect(() => {
    if (!userLocation || !mapRef.current) return;

    if (!hasCenteredRef.current) {
      hasCenteredRef.current = true;
      mapRef.current.flyTo({
        center: [userLocation.lon, userLocation.lat],
        zoom: 15,
        speed: 1.2
      });
    }

    // Add / update user location marker
    if (userMarkerRef.current) {
      userMarkerRef.current.setLngLat([userLocation.lon, userLocation.lat]);
    } else {
      const el = document.createElement('div');
      el.className = 'user-marker';
      el.innerHTML = `
        <div style="
          width: 16px; height: 16px;
          background: #4FC3F7;
          border: 3px solid white;
          border-radius: 50%;
          box-shadow: 0 0 0 4px rgba(79,195,247,0.3);
        "></div>
      `;
      userMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([userLocation.lon, userLocation.lat])
        .addTo(mapRef.current);
    }
  }, [userLocation]);

  // Update stop markers when nearby stops change
  useEffect(() => {
    if (!mapRef.current || !nearbyStops.length) return;

    // Clear old stop markers
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    nearbyStops.forEach(stop => {
      const el = document.createElement('div');
      el.innerHTML = `
        <div style="
          background: #1e2130;
          border: 2px solid #555;
          border-radius: 8px;
          padding: 4px 8px;
          font-size: 11px;
          color: #ccc;
          white-space: nowrap;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        ">
          🚏 ${stop.name}
        </div>
      `;

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([stop.lon, stop.lat])
        .setPopup(new maplibregl.Popup({ offset: 25 })
          .setHTML(`<strong>${stop.name}</strong><br/><small>${Math.round(stop.distance * 1000)}m away</small>`))
        .addTo(mapRef.current);

      markersRef.current.push(marker);
    });
  }, [nearbyStops]);

  // Fetch and render live vehicle positions (viewport-filtered)
  useEffect(() => {
    const allVehiclesRef = { current: [] };

    const renderInViewport = () => {
      if (!mapRef.current) return;
      const bounds = mapRef.current.getBounds();

      vehicleMarkersRef.current.forEach(m => m.remove());
      vehicleMarkersRef.current = [];

      const visible = allVehiclesRef.current.filter(v => bounds.contains([v.lon, v.lat]));

      const tracked = trackedDepartureRef.current;
      let trackedVehicle = null;

      visible.forEach(v => {
        const isTracked = matchesTracked(v, tracked);
        if (isTracked) trackedVehicle = v;

        const icon = CATEGORY_ICON[v.category] || '🚌';
        const el = document.createElement('div');
        el.title = `${icon} ${v.line || v.routeId}`;
        if (isTracked) {
          el.innerHTML = `
            <div style="position:relative;width:32px;height:32px;display:flex;align-items:center;justify-content:center;">
              <div style="
                position:absolute;width:32px;height:32px;border-radius:50%;
                border:2px solid #4FC3F7;animation:trackPulse 1.4s ease-out infinite;
              "></div>
              <div style="
                background:${v.color};border:3px solid white;border-radius:50%;
                width:22px;height:22px;display:flex;align-items:center;justify-content:center;
                font-size:10px;font-weight:800;color:white;
                box-shadow:0 2px 8px rgba(0,0,0,0.6);
                transform:rotate(${v.bearing}deg);z-index:1;
              ">${v.bearing ? '▲' : '•'}</div>
            </div>`;
        } else {
          el.innerHTML = `<div style="
            background:${v.color};
            border:2px solid rgba(255,255,255,0.8);
            border-radius:50%;width:18px;height:18px;
            display:flex;align-items:center;justify-content:center;
            font-size:9px;font-weight:800;color:white;
            box-shadow:0 1px 4px rgba(0,0,0,0.5);
            cursor:default;transform:rotate(${v.bearing}deg);
          ">${v.bearing ? '▲' : '•'}</div>`;
        }

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([v.lon, v.lat])
          .setPopup(new maplibregl.Popup({ offset: 12, closeButton: false })
            .setHTML(`<strong>${icon} ${v.line || '?'}</strong><br/><small>${v.category}</small>`))
          .addTo(mapRef.current);

        vehicleMarkersRef.current.push(marker);
      });

      // Pan to tracked vehicle the first time it's found after selecting
      if (trackedVehicle && lastTrackedIdRef.current === null) {
        const tid = `${tracked.stopCode}-${tracked.journeyNumber}`;
        lastTrackedIdRef.current = tid;
        mapRef.current.flyTo({ center: [trackedVehicle.lon, trackedVehicle.lat], zoom: 15, speed: 1.5 });
      }

      setVehicleCount(visible.length);
    };
    renderInViewportRef.current = renderInViewport;

    const fetchVehicles = async () => {
      if (!mapRef.current) return;
      try {
        const res = await fetch('/api/vehicles');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.vehicles) return;
        allVehiclesRef.current = data.vehicles;
        renderInViewport();
      } catch (e) {
        console.error('Vehicle fetch error:', e);
      }
    };

    mapRef.current?.on('moveend', renderInViewport);
    fetchVehicles();
    const interval = setInterval(fetchVehicles, 5000);
    return () => {
      clearInterval(interval);
      mapRef.current?.off('moveend', renderInViewport);
      vehicleMarkersRef.current.forEach(m => m.remove());
      vehicleMarkersRef.current = [];
    };
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      {!userLocation && (
        <div style={{
          position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(15,17,23,0.85)', color: '#ccc',
          padding: '6px 14px', borderRadius: 20, fontSize: 12,
          pointerEvents: 'none', whiteSpace: 'nowrap',
          border: '1px solid #333'
        }}>
          📍 Pan the map to explore stops
        </div>
      )}
      {vehicleCount > 0 && (
        <div style={{
          position: 'absolute', top: 10, left: 10,
          background: 'rgba(15,17,23,0.85)', color: '#4CAF50',
          padding: '4px 10px', borderRadius: 12, fontSize: 11,
          pointerEvents: 'none', border: '1px solid #1e2130'
        }}>
          🚌 {vehicleCount} live vehicles
        </div>
      )}
      {trackedDeparture && (
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(79,195,247,0.15)', color: '#4FC3F7',
          padding: '4px 12px', borderRadius: 12, fontSize: 11, fontWeight: 600,
          pointerEvents: 'none', border: '1px solid rgba(79,195,247,0.4)',
          whiteSpace: 'nowrap',
        }}>
          📍 Tracking {trackedDeparture.line} → {trackedDeparture.destination}
        </div>
      )}
      <style>{`
        @keyframes trackPulse {
          0%   { transform: scale(1);   opacity: 0.8; }
          100% { transform: scale(2.2); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
