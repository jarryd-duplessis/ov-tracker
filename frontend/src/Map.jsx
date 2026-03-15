import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

const TRANSPORT_COLOURS = {
  BUS: '#4CAF50',
  TRAM: '#FF9800',
  METRO: '#2196F3',
};

const CATEGORY_ICON = { BUS: '🚌', TRAM: '🚊', RAIL: '🚆', SUBWAY: '🚇', FERRY: '⛴️' };

export default function Map({ userLocation, nearbyStops, departures, onMapMove }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const userMarkerRef = useRef(null);
  const vehicleMarkersRef = useRef([]);
  const hasCenteredRef = useRef(false);
  const moveTimerRef = useRef(null);
  const [vehicleCount, setVehicleCount] = useState(0);

  // Initialise map
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

    // Fetch stops for whatever area the user pans to (debounced 600ms, zoom >= 13)
    mapRef.current.on('moveend', () => {
      clearTimeout(moveTimerRef.current);
      moveTimerRef.current = setTimeout(() => {
        const map = mapRef.current;
        if (!map || !onMapMove) return;
        if (map.getZoom() < 13) return;
        const c = map.getCenter();
        onMapMove({ lat: c.lat, lon: c.lng });
      }, 600);
    });

    return () => {
      clearTimeout(moveTimerRef.current);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [onMapMove]);

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

  // Fetch and render live vehicle positions
  useEffect(() => {
    const fetchVehicles = async () => {
      if (!mapRef.current) return;
      try {
        const res = await fetch('/api/vehicles');
        const data = await res.json();
        if (!data.vehicles) return;

        // Clear old vehicle markers
        vehicleMarkersRef.current.forEach(m => m.remove());
        vehicleMarkersRef.current = [];

        data.vehicles.forEach(v => {
          const icon = CATEGORY_ICON[v.category] || '🚌';
          const el = document.createElement('div');
          el.title = `${icon} ${v.line || v.routeId}`;
          el.innerHTML = `<div style="
            background: ${v.color};
            border: 2px solid rgba(255,255,255,0.8);
            border-radius: 50%;
            width: 18px; height: 18px;
            display: flex; align-items: center; justify-content: center;
            font-size: 9px; font-weight: 800; color: white;
            box-shadow: 0 1px 4px rgba(0,0,0,0.5);
            cursor: default;
            transform: rotate(${v.bearing}deg);
          ">${v.bearing ? '▲' : '•'}</div>`;

          const marker = new maplibregl.Marker({ element: el })
            .setLngLat([v.lon, v.lat])
            .setPopup(new maplibregl.Popup({ offset: 12, closeButton: false })
              .setHTML(`<strong>${icon} ${v.line || '?'}</strong><br/><small>${v.category}</small>`))
            .addTo(mapRef.current);

          vehicleMarkersRef.current.push(marker);
        });

        setVehicleCount(data.vehicles.length);
      } catch (e) {
        console.error('Vehicle fetch error:', e);
      }
    };

    fetchVehicles();
    const interval = setInterval(fetchVehicles, 15000);
    return () => clearInterval(interval);
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
    </div>
  );
}
