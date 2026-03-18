import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

// Decode a Google-encoded polyline (supports precision 5 and 7)
function decodePoly(encoded, precision = 5) {
  const factor = Math.pow(10, precision);
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push([lng / factor, lat / factor]); // [lon, lat] for GeoJSON
  }
  return coords;
}

const LEG_COLOUR = {
  BUS: '#4CAF50', TRAM: '#FF9800', SUBWAY: '#2196F3', METRO: '#2196F3',
  RAIL: '#9C27B0', REGIONAL_FAST_RAIL: '#9C27B0', REGIONAL_RAIL: '#9C27B0',
  LONG_DISTANCE: '#E91E63', HIGHSPEED_RAIL: '#E91E63', FERRY: '#00BCD4',
};

const TRANSPORT_COLOURS = {
  BUS: '#4CAF50',
  TRAM: '#FF9800',
  METRO: '#2196F3',
};

const CATEGORY_ICON = { BUS: '🚌', TRAM: '🚊', RAIL: '🚆', SUBWAY: '🚇', FERRY: '⛴️' };

// ── Route-path helpers for route-snapped dead reckoning ─────────────────

// Browser-side cache: routeKey → { coords: [[lon,lat],...], fetchedAt }
const routePathCache = {};
const ROUTE_PATH_TTL = 3600000; // 1 hour

// Parse vehicle ID → { operator, route, journeyNum }
function parseVehicleId(id) {
  const parts = id.split(':');
  if (parts.length < 4) return null;
  return { operator: parts[1], route: parts[2], journeyNum: parts[3] };
}

// Fetch route path (stop coordinates) for a vehicle — returns [[lon,lat], ...] or null
async function getRoutePath(vehicle) {
  const parsed = parseVehicleId(vehicle.id);
  if (!parsed) return null;
  const key = `${parsed.operator}_${parsed.route}`;
  const cached = routePathCache[key];
  if (cached && Date.now() - cached.fetchedAt < ROUTE_PATH_TTL) return cached.coords;
  if (cached === null) return null; // already tried and failed

  try {
    const params = new URLSearchParams({ vehicleId: vehicle.id });
    if (vehicle.line) params.set('line', vehicle.line);
    const res = await fetch(`/api/trip?${params}`);
    const data = await res.json();
    if (data.error || !data.stops || data.stops.length < 2) {
      routePathCache[key] = null;
      return null;
    }
    // Prefer shape geometry (dense road waypoints) over stop coordinates (straight lines)
    const coords = data.shape && data.shape.length >= 2
      ? data.shape
      : data.stops.map(s => [s.lon, s.lat]);
    routePathCache[key] = { coords, fetchedAt: Date.now() };
    return coords;
  } catch {
    routePathCache[key] = null;
    return null;
  }
}

// Squared distance between two points (no sqrt for perf)
function distSq(ax, ay, bx, by) { return (ax - bx) ** 2 + (ay - by) ** 2; }

// Project point P onto segment AB, return { t, x, y } where t is 0-1
function projectOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return { t: 0, x: ax, y: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return { t, x: ax + t * dx, y: ay + t * dy };
}

// Find where a point is on a polyline path — returns { segIdx, t, distAlong }
// distAlong is the cumulative distance (in degrees, approximate) from start of path
function findOnPath(lon, lat, coords) {
  let bestDist = Infinity, bestSeg = 0, bestT = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const proj = projectOnSegment(lon, lat, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    const d = distSq(lon, lat, proj.x, proj.y);
    if (d < bestDist) { bestDist = d; bestSeg = i; bestT = proj.t; }
  }
  // Compute cumulative distance along path to this point
  let distAlong = 0;
  for (let i = 0; i < bestSeg; i++) {
    distAlong += Math.sqrt(distSq(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]));
  }
  distAlong += bestT * Math.sqrt(distSq(coords[bestSeg][0], coords[bestSeg][1], coords[bestSeg + 1][0], coords[bestSeg + 1][1]));
  return { segIdx: bestSeg, t: bestT, distAlong };
}

// Walk `dist` degrees along the path from a starting position { segIdx, t }
// Returns [lon, lat] and the new bearing
function walkAlongPath(coords, segIdx, t, dist) {
  let remaining = dist;
  let i = segIdx;

  // Consume remaining portion of current segment
  const segLen = Math.sqrt(distSq(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]));
  const leftOnSeg = segLen * (1 - t);
  if (remaining <= leftOnSeg) {
    const frac = t + (remaining / (segLen || 1));
    const lon = coords[i][0] + frac * (coords[i + 1][0] - coords[i][0]);
    const lat = coords[i][1] + frac * (coords[i + 1][1] - coords[i][1]);
    const bearing = Math.atan2(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]) * 180 / Math.PI;
    return { lon, lat, bearing };
  }
  remaining -= leftOnSeg;
  i++;

  // Walk through subsequent segments
  while (i < coords.length - 1) {
    const sl = Math.sqrt(distSq(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]));
    if (remaining <= sl) {
      const frac = remaining / (sl || 1);
      const lon = coords[i][0] + frac * (coords[i + 1][0] - coords[i][0]);
      const lat = coords[i][1] + frac * (coords[i + 1][1] - coords[i][1]);
      const bearing = Math.atan2(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]) * 180 / Math.PI;
      return { lon, lat, bearing };
    }
    remaining -= sl;
    i++;
  }

  // Past the end of the route — clamp to last point
  const last = coords[coords.length - 1];
  return { lon: last[0], lat: last[1], bearing: null };
}

// Returns true if a vehicle matches the tracked departure
function matchesTracked(vehicle, dep, journeyRoute) {
  if (!dep) return false;
  // Match the resolved vehicle ID (proximity-validated during route fetch)
  if (journeyRoute?._vehicleId && vehicle.id === journeyRoute._vehicleId) return true;
  // Also match by exact journey number + line (vehicle may have appeared after initial search)
  if (journeyRoute?._journeyNum && journeyRoute._line) {
    if (vehicle.id.endsWith(`:${journeyRoute._journeyNum}`) && vehicle.line === journeyRoute._line) return true;
  }
  return false;
}

function applyStopStyle(el, name, distanceM, isHighlighted) {
  if (isHighlighted) {
    el.innerHTML = `<div style="
      background: var(--accent);
      border: 2px solid var(--accent);
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 12px;
      color: #000;
      white-space: nowrap;
      cursor: pointer;
      font-weight: 800;
      box-shadow: 0 0 0 4px var(--accent-border), 0 2px 12px rgba(0,0,0,0.4);
      transform: scale(1.1);
      transition: all 0.2s;
    ">📍 ${name}</div>`;
  } else {
    el.innerHTML = `<div style="
      background: var(--stop-bg);
      border: 2px solid var(--stop-border);
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--stop-text);
      white-space: nowrap;
      cursor: pointer;
      font-weight: 400;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      transition: all 0.2s;
    ">🚏 ${name}</div>`;
  }
}

const MAP_STYLES = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/liberty',
};

export default function Map({ theme, userLocation, nearbyStops, selectedStop, departures, onMapMove, onFollowVehicle, onStopClick, onVehicleSelect, selectedVehicle, trackedDeparture, centerOn, journeyRoute, appVisible = true }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const stopMarkersMapRef = useRef({}); // tpc → { marker, el } — incremental updates, no flicker
  const stopMarkerElsRef = useRef({}); // tpc → DOM element, for style updates without recreation
  const nearbyStopsRef = useRef(nearbyStops);
  const userMarkerRef = useRef(null);
  const vehicleMarkersRef = useRef([]);
  const hasCenteredRef = useRef(false);
  const moveTimerRef = useRef(null);
  const onMapMoveRef = useRef(onMapMove);
  const onFollowVehicleRef = useRef(onFollowVehicle);
  const onStopClickRef = useRef(onStopClick);
  const onVehicleSelectRef = useRef(onVehicleSelect);
  const trackedDepartureRef = useRef(trackedDeparture);
  const lastTrackedIdRef = useRef(null);
  const renderInViewportRef = useRef(null);
  const followedVehicleIdRef = useRef(null);
  const [vehicleCount, setVehicleCount] = useState(0);
  const [followedVehicle, setFollowedVehicle] = useState(null);
  const userInitiatedRef = useRef(false);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const allVehiclesRef = useRef([]);

  // ── Idle detection: pause vehicle fetch after 30s of no interaction ──
  const IDLE_TIMEOUT = 30000;
  const [mapIdle, setMapIdle] = useState(false);
  const idleTimerRef = useRef(null);
  const paused = !appVisible || mapIdle;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Reset idle timer on user interaction
  useEffect(() => {
    const container = mapContainer.current;
    if (!container) return;

    const resetIdle = () => {
      setMapIdle(false);
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => setMapIdle(true), IDLE_TIMEOUT);
    };

    // Start the initial idle timer
    idleTimerRef.current = setTimeout(() => setMapIdle(true), IDLE_TIMEOUT);

    const events = ['mousedown', 'touchstart', 'wheel', 'mousemove', 'keydown'];
    events.forEach(e => container.addEventListener(e, resetIdle, { passive: true }));
    return () => {
      clearTimeout(idleTimerRef.current);
      events.forEach(e => container.removeEventListener(e, resetIdle));
    };
  }, [styleEpoch]); // re-attach after map style reload (styleEpoch changes on theme switch)

  // Switch map tile style when theme changes
  const themeRef = useRef(theme);
  useEffect(() => {
    if (!mapRef.current || theme === themeRef.current) return;
    themeRef.current = theme;
    mapRef.current.setStyle(MAP_STYLES[theme] || MAP_STYLES.dark);
    // setStyle destroys all sources/layers — bump epoch so the route effect re-runs
    mapRef.current.once('style.load', () => setStyleEpoch(e => e + 1));
  }, [theme]);

  // Explicit fly-to from parent (e.g. journey planner selects a boarding stop)
  useEffect(() => {
    if (!centerOn || !mapRef.current) return;
mapRef.current.flyTo({ center: [centerOn.lon, centerOn.lat], zoom: 15, speed: 1.2 });
  }, [centerOn]);

  // Store journeyRoute in a ref so the vehicle render loop can read it for progress updates
  const journeyRouteRef = useRef(journeyRoute);
  useEffect(() => { journeyRouteRef.current = journeyRoute; }, [journeyRoute]);

  // Draw / clear the tracked departure's route as a GeoJSON line layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const emptyFC = { type: 'FeatureCollection', features: [] };
    const geojson = { type: 'FeatureCollection', features: [] };
    const walkGeojson = { type: 'FeatureCollection', features: [] };
    const stopsGeojson = { type: 'FeatureCollection', features: [] };
    const routeColour = journeyRoute?._colour || '#4FC3F7';

    if (journeyRoute) {
      // Trip-based route (from /api/trip) — raw coords, no encoded polyline
      if (journeyRoute._rawCoords && journeyRoute._rawCoords.length >= 2) {
        geojson.features.push({
          type: 'Feature',
          properties: { color: routeColour },
          geometry: { type: 'LineString', coordinates: journeyRoute._rawCoords },
        });

        // Add stop markers along the route
        if (journeyRoute._stops) {
          const depStopCode = journeyRoute._departureStopCode;
          journeyRoute._stops.forEach((stop, i) => {
            const isFirst = i === 0;
            const isLast = i === journeyRoute._stops.length - 1;
            // Match departure stop by proximity (OVapi TPC ≠ GTFS stop_id)
            const isUserStop = depStopCode && nearbyStopsRef.current.some(ns =>
              ns.tpc === depStopCode &&
              Math.abs(ns.lat - stop.lat) < 0.001 && Math.abs(ns.lon - stop.lon) < 0.001
            );
            stopsGeojson.features.push({
              type: 'Feature',
              properties: {
                name: stop.name,
                isFirst, isLast, isUserStop,
                time: stop.dep || stop.arr || '',
                platform: stop.platform || '',
                radius: isFirst || isLast ? 6 : isUserStop ? 7 : 4,
                color: isUserStop ? '#FFD740' : isFirst || isLast ? routeColour : '#ffffff',
                strokeColor: isUserStop ? '#FFD740' : routeColour,
                strokeWidth: isFirst || isLast || isUserStop ? 3 : 2,
              },
              geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
            });
          });
        }
      } else {
        // Journey planner route (from Motis) — encoded polylines per leg
        for (const leg of journeyRoute.legs) {
          if (!leg.legGeometry?.points) {
            if (leg.mode === 'WALK' && leg.from?.lon != null && leg.to?.lon != null) {
              walkGeojson.features.push({
                type: 'Feature', properties: {},
                geometry: { type: 'LineString', coordinates: [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]] },
              });
            }
            continue;
          }
          const color = LEG_COLOUR[leg.mode] || '#4FC3F7';
          try {
            const coords = decodePoly(leg.legGeometry.points, leg.legGeometry.precision ?? 5);
            if (coords.length >= 2) {
              if (leg.mode === 'WALK') {
                walkGeojson.features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
              } else {
                geojson.features.push({ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: coords } });
              }
            }
          } catch { /* malformed polyline — skip */ }
        }
      }
    }

    const apply = () => {
      // Route line (dimmer — the progress overlay will be bright)
      if (map.getSource('journey-route')) {
        map.getSource('journey-route').setData(geojson);
      } else {
        map.addSource('journey-route', { type: 'geojson', data: geojson });
        const beforeLayer = map.getLayer('road-label') ? 'road-label' : undefined;
        map.addLayer({
          id: 'journey-route-line', type: 'line', source: 'journey-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 0.4 },
        }, beforeLayer);
      }

      // Vehicle progress (traveled portion) — brighter overlay
      if (map.getSource('journey-progress')) {
        map.getSource('journey-progress').setData(emptyFC);
      } else {
        map.addSource('journey-progress', { type: 'geojson', data: emptyFC });
        map.addLayer({
          id: 'journey-progress-line', type: 'line', source: 'journey-progress',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 0.9 },
        });
      }

      // Walk segments as dashed lines
      if (map.getSource('journey-walk')) {
        map.getSource('journey-walk').setData(walkGeojson);
      } else {
        map.addSource('journey-walk', { type: 'geojson', data: walkGeojson });
        map.addLayer({
          id: 'journey-walk-line', type: 'line', source: 'journey-walk',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#888', 'line-width': 3, 'line-opacity': 0.7, 'line-dasharray': [2, 3] },
        });
      }

      // Route stop circles
      if (map.getSource('journey-stops')) {
        map.getSource('journey-stops').setData(stopsGeojson);
      } else {
        map.addSource('journey-stops', { type: 'geojson', data: stopsGeojson });
        map.addLayer({
          id: 'journey-stops-circle', type: 'circle', source: 'journey-stops',
          paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-stroke-color': ['get', 'strokeColor'],
            'circle-stroke-width': ['get', 'strokeWidth'],
          },
        });
        // Stop name labels (visible at zoom >= 14)
        map.addLayer({
          id: 'journey-stops-label', type: 'symbol', source: 'journey-stops',
          minzoom: 14,
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.5],
            'text-anchor': 'top',
            'text-max-width': 12,
          },
          paint: {
            'text-color': 'var(--text, #eee)',
            'text-halo-color': 'var(--bg, #000)',
            'text-halo-width': 1.5,
          },
        });
      }

      // Fit map to show the full route
      const allFeatures = [...geojson.features, ...walkGeojson.features];
      if (allFeatures.length > 0) {
        const allCoords = allFeatures.flatMap(f => f.geometry.coordinates);
        if (allCoords.length >= 2) {
          const lngs = allCoords.map(c => c[0]);
          const lats = allCoords.map(c => c[1]);
          map.fitBounds(
            [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
            { padding: 60, duration: 800 }
          );
        }
      }
    };

    if (map.isStyleLoaded()) {
      apply();
    } else {
      const wrappedApply = () => apply();
      map.once('style.load', wrappedApply);
      return () => { map.off('style.load', wrappedApply); };
    }
  }, [journeyRoute, styleEpoch]);

  // Keep refs current without triggering map re-initialisation
  useEffect(() => { onMapMoveRef.current = onMapMove; }, [onMapMove]);
  useEffect(() => { onFollowVehicleRef.current = onFollowVehicle; }, [onFollowVehicle]);
  useEffect(() => { onStopClickRef.current = onStopClick; }, [onStopClick]);
  useEffect(() => { onVehicleSelectRef.current = onVehicleSelect; }, [onVehicleSelect]);
  // Sync followed-vehicle state when parent clears selectedVehicle (e.g. TripPanel close)
  useEffect(() => {
    if (!selectedVehicle && followedVehicleIdRef.current) {
      followedVehicleIdRef.current = null;
      setFollowedVehicle(null);
    }
  }, [selectedVehicle]);
  useEffect(() => { nearbyStopsRef.current = nearbyStops; }, [nearbyStops]);
  useEffect(() => {
    const prev = trackedDepartureRef.current;
    trackedDepartureRef.current = trackedDeparture;
    // Reset so the map pans again when a new departure is selected,
    // then immediately re-render so it pans without waiting for the next poll
    lastTrackedIdRef.current = null;
    renderInViewportRef.current?.();

    // Reset previously tracked stop's highlight
    if (prev?.stopCode && stopMarkerElsRef.current[prev.stopCode]) {
      const s = nearbyStopsRef.current.find(s => s.tpc === prev.stopCode);
      if (s) applyStopStyle(stopMarkerElsRef.current[prev.stopCode], s.name, Math.round(s.distance * 1000), false);
    }

    // Highlight the newly tracked stop and fly to it
    if (trackedDeparture?.stopCode) {
      const stop = nearbyStopsRef.current.find(s => s.tpc === trackedDeparture.stopCode);
      if (stop) {
        if (stopMarkerElsRef.current[stop.tpc]) {
          applyStopStyle(stopMarkerElsRef.current[stop.tpc], stop.name, Math.round(stop.distance * 1000), true);
        }
        mapRef.current?.flyTo({
          center: [stop.lon, stop.lat],
          zoom: Math.max(mapRef.current?.getZoom() || 15, 15),
          speed: 1.2,
        });
      }
    }
  }, [trackedDeparture]);

  // Initialise map — empty deps so it never tears down due to prop changes
  useEffect(() => {
    if (mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLES[theme] || MAP_STYLES.dark,
      center: [4.9, 52.37], // Default: Amsterdam
      zoom: 14,
      attributionControl: true
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right');

    // Watch container size — calls resize() whenever the flex layout gives the
    // container its real pixel dimensions (fixes blank tile loading on mobile)
    const resizeObserver = new ResizeObserver(() => mapRef.current?.resize());
    resizeObserver.observe(mapContainer.current);

    // Track whether the current map movement was user-initiated (touch/mouse)
    // vs programmatic (flyTo, setCenter, easeTo). Only user-initiated pans
    // should re-fetch stops — programmatic movements happen when we fly to a
    // tracked departure or selected journey and must not override the subscription.
    let moveStartCenter = null;
    mapRef.current.on('movestart', (e) => {
      userInitiatedRef.current = !!e.originalEvent;
      if (userInitiatedRef.current && mapRef.current) {
        const c = mapRef.current.getCenter();
        moveStartCenter = { lat: c.lat, lon: c.lng };
      }
    });

    // Fetch stops for whatever area the user pans to (debounced 600ms, zoom >= 13)
    // Zoom-only interactions (center barely moves) refresh stops but keep the selection
    mapRef.current.on('moveend', () => {
      if (!userInitiatedRef.current) return; // programmatic flyTo — keep current stop subscription
      clearTimeout(moveTimerRef.current);
      moveTimerRef.current = setTimeout(() => {
        const map = mapRef.current;
        if (!map || !onMapMoveRef.current) return;
        if (map.getZoom() < 13) return;
        const c = map.getCenter();
        // Detect zoom-only: center moved less than ~50m
        const isPan = !moveStartCenter ||
          Math.hypot((c.lat - moveStartCenter.lat) * 111000, (c.lng - moveStartCenter.lon) * 68000) > 50;
        const ne = map.getBounds().getNorthEast();
        const dLat = (ne.lat - c.lat) * Math.PI / 180;
        const dLon = (ne.lng - c.lng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(c.lat*Math.PI/180)**2 * Math.sin(dLon/2)**2;
        const radius = Math.min(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)), 1.5);
        // Only reset user selection on actual pans, not zoom
        onMapMoveRef.current({ lat: c.lat, lon: c.lng, radius, isPan });
      }, 600);
    });

    return () => {
      clearTimeout(moveTimerRef.current);
      resizeObserver.disconnect();
      // Clear marker refs so a remount starts clean (map.remove() destroys them in the DOM)
      stopMarkersMapRef.current = {};
      stopMarkerElsRef.current = {};
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

  // Update stop markers incrementally — only add/remove what changed to prevent flicker
  useEffect(() => {
    if (!mapRef.current) return;

    const newTpcs = new Set(nearbyStops.map(s => s.tpc));

    // Remove markers for stops that are no longer in the list
    for (const tpc of Object.keys(stopMarkersMapRef.current)) {
      if (!newTpcs.has(tpc)) {
        stopMarkersMapRef.current[tpc].marker.remove();
        delete stopMarkersMapRef.current[tpc];
        delete stopMarkerElsRef.current[tpc];
      }
    }

    // Add new markers / refresh style on existing ones
    nearbyStops.forEach(stop => {
      const isHighlighted = selectedStop === stop.tpc;
      if (stopMarkersMapRef.current[stop.tpc]) {
        // Already on map — just refresh style (distance label may have changed)
        const el = stopMarkerElsRef.current[stop.tpc];
        applyStopStyle(el, stop.name, Math.round(stop.distance * 1000), isHighlighted);
        // Keep stop markers above vehicle markers; selected stop on top
        el.style.zIndex = isHighlighted ? '20' : '10';
      } else {
        // New stop — create marker
        const el = document.createElement('div');
        el.style.zIndex = isHighlighted ? '20' : '10';
        applyStopStyle(el, stop.name, Math.round(stop.distance * 1000), isHighlighted);
        stopMarkerElsRef.current[stop.tpc] = el;

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          // Suppress the moveend handler so clicking a stop doesn't trigger onMapMove
          userInitiatedRef.current = false;
          // Cancel any pending debounced onMapMove from a previous pan
          clearTimeout(moveTimerRef.current);
          onStopClickRef.current?.(stop);
        });

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([stop.lon, stop.lat])
          .addTo(mapRef.current);

        stopMarkersMapRef.current[stop.tpc] = { marker, el };
      }
    });
  }, [nearbyStops, selectedStop]);

  // Fetch and render live vehicle positions (viewport-filtered)
  useEffect(() => {
    // Persistent marker state keyed by vehicle id — survives between polls
    const stateRef = { current: {} }; // id → { marker, el, lat, lon, styleKey }
    // Single shared animation loop — avoids N concurrent rAF callbacks competing
    // with MapLibre's own render loop (which caused sluggish zoom)
    // id → { fromLat, fromLon, toLat, toLon, startTime, speed, bearing, routePath }
    // After the 1.5s interpolation, dead reckoning continues along the route path
    // (falls back to straight-line bearing if no route path available)
    const animsRef = { current: {} };
    // id → [[lon,lat],...] — cached route paths for route-snapped dead reckoning
    const routePathsRef = { current: {} };
    // Track in-flight route path fetches to avoid duplicate requests
    const routePathFetchingRef = { current: new Set() };
    let rafId = null;
    // Pause camera locking while the user is zooming/panning so gestures aren't overridden
    let userInteracting = false;
    let interactTimeout = null;
    const onMoveStart = (e) => {
      if (e.originalEvent) { // user-initiated (not our setCenter calls)
        userInteracting = true;
        clearTimeout(interactTimeout);
        interactTimeout = setTimeout(() => { userInteracting = false; }, 800);
      }
    };
    mapRef.current?.on('movestart', onMoveStart);

    const INTERP_MS = 4000; // interpolation duration to new GPS position (matches ~5s data refresh)
    const DR_MAX_MS = 20000; // max dead reckoning time after interpolation ends
    const DEFAULT_SPEED = 8; // ~30 km/h fallback when speed is 0 but vehicle was moving

    // Snap a lat/lon to the nearest point on the route path
    function snapToPath(rawLon, rawLat, path) {
      const pos = findOnPath(rawLon, rawLat, path);
      // Reconstruct the snapped point from the segment
      const a = path[pos.segIdx];
      const b = path[pos.segIdx + 1];
      return {
        lon: a[0] + pos.t * (b[0] - a[0]),
        lat: a[1] + pos.t * (b[1] - a[1]),
        bearing: Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI,
        segIdx: pos.segIdx,
        t: pos.t,
        distAlong: pos.distAlong,
      };
    }

    function startLoop() {
      if (rafId !== null) return;
      const tick = (now) => {
        const anims = animsRef.current;
        let active = false;
        for (const id of Object.keys(anims)) {
          const s = stateRef.current[id];
          if (!s) { delete anims[id]; continue; }
          const a = anims[id];
          const elapsed = now - a.startTime;

          let lat, lon;
          if (elapsed < INTERP_MS) {
            // Phase 1: smooth interpolation to the GPS position (ease-in-out)
            const raw = elapsed / INTERP_MS;
            const t = raw * raw * (3 - 2 * raw); // smoothstep — no abrupt start/stop

            // Linear interpolation first
            lon = a.fromLon + (a.toLon - a.fromLon) * t;
            lat = a.fromLat + (a.toLat - a.fromLat) * t;

            // Snap the interpolated position to the route shape
            if (a.routePath && a.routePath.length >= 2) {
              const snapped = snapToPath(lon, lat, a.routePath);
              lon = snapped.lon;
              lat = snapped.lat;
              if (snapped.bearing != null) {
                updateBearing(s.el, snapped.bearing);
              }
            }
            active = true;
          } else if (elapsed < INTERP_MS + DR_MAX_MS) {
            // Phase 2: dead reckoning along route path
            // Use actual speed, or estimate from the distance moved during interpolation
            const drSpeed = a.speed > 0.5 ? a.speed
              : (a.routePath ? DEFAULT_SPEED : 0); // only DR with fallback speed if we have a route
            if (drSpeed < 0.1) { delete anims[id]; continue; }
            const drSec = (elapsed - INTERP_MS) / 1000;
            // Gradually slow down dead reckoning over time to avoid overshooting
            const slowdown = Math.max(0.3, 1 - drSec / (DR_MAX_MS / 1000));
            const distDeg = (drSpeed * slowdown * drSec) / 111111;

            if (a.routePath && a.routePath.length >= 2) {
              if (!a._toPathPos) {
                a._toPathPos = findOnPath(a.toLon, a.toLat, a.routePath);
              }
              const result = walkAlongPath(a.routePath, a._toPathPos.segIdx, a._toPathPos.t, distDeg);
              lon = result.lon;
              lat = result.lat;
              if (result.bearing != null) {
                a.bearing = result.bearing;
                updateBearing(s.el, result.bearing);
              }
            } else if (a.bearing != null) {
              const bearRad = a.bearing * Math.PI / 180;
              const cosLat = Math.cos(a.toLat * Math.PI / 180);
              lat = a.toLat + (a.speed * Math.cos(bearRad) * drSec) / 111111;
              lon = a.toLon + (a.speed * Math.sin(bearRad) * drSec) / (111111 * cosLat);
            } else {
              delete anims[id];
              continue;
            }
            active = true;
          } else {
            delete anims[id];
            continue;
          }
          s.marker.setLngLat([lon, lat]);
        }
        rafId = active ? requestAnimationFrame(tick) : null;
      };
      rafId = requestAnimationFrame(tick);
    }

    function applyStyle(el, v, isTracked, isFollowed) {
      const rot = v.bearing ? `transform:rotate(${v.bearing}deg);` : '';
      if (isTracked || isFollowed) {
        el.innerHTML = `
          <div style="position:relative;width:32px;height:32px;display:flex;align-items:center;justify-content:center;">
            <div style="
              position:absolute;width:32px;height:32px;border-radius:50%;
              border:2px solid ${isFollowed ? '#FFD740' : '#4FC3F7'};
              animation:trackPulse 1.4s ease-out infinite;
            "></div>
            <div style="
              background:${v.color};border:3px solid white;border-radius:50%;
              width:24px;height:24px;display:flex;align-items:center;justify-content:center;
              font-size:11px;font-weight:800;color:white;
              box-shadow:0 2px 8px rgba(0,0,0,0.6);z-index:1;${rot}
            ">${v.bearing ? '▲' : '•'}</div>
          </div>`;
      } else {
        el.innerHTML = `<div style="
          background:${v.color};
          border:2px solid var(--vehicle-border);
          border-radius:50%;width:18px;height:18px;
          display:flex;align-items:center;justify-content:center;
          font-size:9px;font-weight:800;color:white;
          box-shadow:0 1px 4px rgba(0,0,0,0.5);${rot}
        ">${v.bearing ? '▲' : '•'}</div>`;
      }
    }

    function updateBearing(el, bearing) {
      const inner = el.firstElementChild;
      if (inner && bearing) {
        inner.style.transform = `rotate(${bearing}deg)`;
        inner.style.transition = 'transform 1s ease-out';
      }
    }

    const renderInViewport = () => {
      if (!mapRef.current) return;
      const map = mapRef.current;

      if (map.getZoom() < 11) {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        Object.values(stateRef.current).forEach(s => s.marker.remove());
        stateRef.current = {};
        animsRef.current = {};
        setVehicleCount(0);
        return;
      }

      const bounds = map.getBounds();
      const tracked = trackedDepartureRef.current;
      const followedId = followedVehicleIdRef.current;
      const allVehicles = allVehiclesRef.current;

      const visibleVehicles = allVehicles.filter(v => bounds.contains([v.lon, v.lat]));
      const visibleIds = new Set(visibleVehicles.map(v => v.id));

      const followedVehicle = followedId ? allVehicles.find(v => v.id === followedId) : null;
      if (followedVehicle && !visibleIds.has(followedId)) {
        visibleVehicles.push(followedVehicle);
        visibleIds.add(followedId);
      }

      // Remove markers that left the viewport (keep route paths cached — they're reusable)
      for (const id of Object.keys(stateRef.current)) {
        if (!visibleIds.has(id)) {
          stateRef.current[id].marker.remove();
          delete stateRef.current[id];
          delete animsRef.current[id];
        }
      }

      let trackedVehicle = null;

      for (const v of visibleVehicles) {
        const isTracked = matchesTracked(v, tracked, journeyRouteRef.current);
        const isFollowed = v.id === followedId;
        if (isTracked) trackedVehicle = v;

        const styleKey = `${isTracked ? 1 : 0}-${isFollowed ? 1 : 0}`;
        const s = stateRef.current[v.id];

        if (s) {
          // Only rewrite innerHTML when highlight state actually changes
          if (s.styleKey !== styleKey) { applyStyle(s.el, v, isTracked, isFollowed); s.styleKey = styleKey; }

          // Smoothly rotate to new bearing
          if (v.bearing && v.bearing !== s.bearing) {
            updateBearing(s.el, v.bearing);
            s.bearing = v.bearing;
          }

          if (s.lat !== v.lat || s.lon !== v.lon) {
            // Use the marker's CURRENT screen position as the start point,
            // not the previous GPS position — avoids jump-back when dead reckoning
            // has moved the marker ahead of the last known GPS position.
            const currentLngLat = s.marker.getLngLat();
            const routePath = routePathsRef.current[v.id] || null;

            const anim = {
              fromLat: currentLngLat.lat, fromLon: currentLngLat.lng,
              toLat: v.lat, toLon: v.lon,
              speed: v.speed || 0, bearing: v.bearing,
              startTime: performance.now(),
              routePath,
            };
            animsRef.current[v.id] = anim;

            // Fetch route path if we don't have one yet (non-blocking)
            if (!routePath && !routePathFetchingRef.current.has(v.id)) {
              routePathFetchingRef.current.add(v.id);
              getRoutePath(v).then(coords => {
                routePathFetchingRef.current.delete(v.id);
                if (coords) {
                  routePathsRef.current[v.id] = coords;
                  const currentAnim = animsRef.current[v.id];
                  if (currentAnim && !currentAnim.routePath) {
                    currentAnim.routePath = coords;
                  }
                }
              });
            }

            s.lat = v.lat;
            s.lon = v.lon;
            startLoop();
          }
        } else {
          const el = document.createElement('div');
          el.title = `${CATEGORY_ICON[v.category] || '🚌'} ${v.line || v.routeId}`;
          el.style.cursor = 'pointer';
          el.style.zIndex = '1'; // Keep vehicle markers below stop markers (z-index 10/20)
          applyStyle(el, v, isTracked, isFollowed);

          el.addEventListener('click', (e) => {
            e.stopPropagation();
            userInitiatedRef.current = false; // suppress moveend handler
            if (followedVehicleIdRef.current === v.id) {
              followedVehicleIdRef.current = null;
              setFollowedVehicle(null);
              onVehicleSelectRef.current?.(null);
            } else {
              followedVehicleIdRef.current = v.id;
              setFollowedVehicle({ id: v.id, line: v.line, category: v.category, color: v.color });
              onVehicleSelectRef.current?.(v);
            }
          });

          const marker = new maplibregl.Marker({ element: el }).setLngLat([v.lon, v.lat]).addTo(mapRef.current);
          stateRef.current[v.id] = { marker, el, lat: v.lat, lon: v.lon, bearing: v.bearing, styleKey };
        }
      }

      // (Camera no longer follows vehicles — just highlights them in place)

      // Note: camera is handled by the route drawing effect's fitBounds,
      // not by flying to the vehicle position (which could be wrong or far away)

      // Update vehicle progress line (traveled portion of the route)
      const jr = journeyRouteRef.current;
      if (jr?._rawCoords && jr._rawCoords.length >= 2 && map.getSource('journey-progress')) {
        let traveled = null;

        if (trackedVehicle && (jr._isExactVehicle || trackedVehicle.id.endsWith(`:${jr._journeyNum}`))) {
          // GPS-based progress: project the exact vehicle's position onto the route
          const pos = findOnPath(trackedVehicle.lon, trackedVehicle.lat, jr._rawCoords);
          traveled = jr._rawCoords.slice(0, pos.segIdx + 1);
          const a = jr._rawCoords[pos.segIdx];
          const b = jr._rawCoords[pos.segIdx + 1];
          if (a && b) {
            traveled.push([a[0] + pos.t * (b[0] - a[0]), a[1] + pos.t * (b[1] - a[1])]);
          }
        } else if (jr._stops && jr._stops.length >= 2) {
          // Schedule-based progress: estimate position from timetable
          const now = new Date();
          const h = now.getHours(), m = now.getMinutes();
          const nowMins = h * 60 + m;
          // Parse stop times (HH:MM:SS format) and find where we are in the schedule
          let lastPassedStop = -1;
          let fraction = 0;
          for (let i = 0; i < jr._stops.length; i++) {
            const timeStr = jr._stops[i].dep || jr._stops[i].arr;
            if (!timeStr) continue;
            const parts = timeStr.split(':');
            const stopMins = parseInt(parts[0]) * 60 + parseInt(parts[1]) + (jr._delay || 0);
            if (nowMins >= stopMins) {
              lastPassedStop = i;
              // Compute fraction to next stop
              if (i < jr._stops.length - 1) {
                const nextTimeStr = jr._stops[i + 1].dep || jr._stops[i + 1].arr;
                if (nextTimeStr) {
                  const nextParts = nextTimeStr.split(':');
                  const nextMins = parseInt(nextParts[0]) * 60 + parseInt(nextParts[1]) + (jr._delay || 0);
                  const span = nextMins - stopMins;
                  fraction = span > 0 ? Math.min(1, (nowMins - stopMins) / span) : 0;
                }
              }
            }
          }
          if (lastPassedStop >= 0) {
            // Find the route coords for this stop and interpolate
            const stopCoord = [jr._stops[lastPassedStop].lon, jr._stops[lastPassedStop].lat];
            const pos = findOnPath(stopCoord[0], stopCoord[1], jr._rawCoords);
            let endIdx = pos.segIdx;
            let endT = pos.t;
            // If between stops, interpolate further along the route
            if (fraction > 0 && lastPassedStop < jr._stops.length - 1) {
              const nextCoord = [jr._stops[lastPassedStop + 1].lon, jr._stops[lastPassedStop + 1].lat];
              const nextPos = findOnPath(nextCoord[0], nextCoord[1], jr._rawCoords);
              // Interpolate between the two positions on the route
              const totalDist = nextPos.distAlong - pos.distAlong;
              const targetDist = pos.distAlong + totalDist * fraction;
              // Walk along to find the right segment
              let cumDist = 0;
              for (let i = 0; i < jr._rawCoords.length - 1; i++) {
                const segLen = Math.sqrt(distSq(jr._rawCoords[i][0], jr._rawCoords[i][1], jr._rawCoords[i+1][0], jr._rawCoords[i+1][1]));
                if (cumDist + segLen >= targetDist) {
                  endIdx = i;
                  endT = (targetDist - cumDist) / (segLen || 1);
                  break;
                }
                cumDist += segLen;
              }
            }
            traveled = jr._rawCoords.slice(0, endIdx + 1);
            const a = jr._rawCoords[endIdx];
            const b = jr._rawCoords[endIdx + 1];
            if (a && b) {
              traveled.push([a[0] + endT * (b[0] - a[0]), a[1] + endT * (b[1] - a[1])]);
            }
          }
        }

        if (traveled && traveled.length >= 2) {
          map.getSource('journey-progress').setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: { color: jr._colour || '#4FC3F7' }, geometry: { type: 'LineString', coordinates: traveled } }],
          });
        }
      }

      setVehicleCount(visibleIds.size);
    };
    renderInViewportRef.current = renderInViewport;

    const fetchVehicles = async () => {
      if (!mapRef.current || pausedRef.current) return;
      try {
        // Viewport-filtered fetch: only get vehicles visible on the map
        const bounds = mapRef.current.getBounds();
        const bbox = `${bounds.getSouth().toFixed(3)},${bounds.getWest().toFixed(3)},${bounds.getNorth().toFixed(3)},${bounds.getEast().toFixed(3)}`;
        const res = await fetch(`/api/vehicles?bbox=${bbox}`);
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
    const interval = setInterval(fetchVehicles, 5000); // 5s matches backend refresh rate
    return () => {
      clearInterval(interval);
      clearTimeout(interactTimeout);
      if (rafId !== null) cancelAnimationFrame(rafId);
      mapRef.current?.off('moveend', renderInViewport);
      mapRef.current?.off('movestart', onMoveStart);
      Object.values(stateRef.current).forEach(s => s.marker.remove());
      stateRef.current = {};
    };
  }, []);

  // When resuming from paused, fetch vehicles immediately
  useEffect(() => {
    if (!paused && renderInViewportRef.current && mapRef.current) {
      // Fetch fresh data immediately on resume
      (async () => {
        try {
          const res = await fetch('/api/vehicles');
          if (!res.ok) return;
          const data = await res.json();
          if (!data.vehicles) return;
          allVehiclesRef.current = data.vehicles;
          renderInViewportRef.current();
        } catch (e) { /* will retry on next interval tick */ }
      })();
    }
  }, [paused]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      {!userLocation && (
        <div style={{
          position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--overlay-bg)', color: 'var(--text-secondary)',
          padding: '6px 14px', borderRadius: 20, fontSize: 12,
          pointerEvents: 'none', whiteSpace: 'nowrap',
          border: '1px solid var(--overlay-border)'
        }}>
          📍 Pan the map to explore stops
        </div>
      )}
      {vehicleCount > 0 && (
        <div style={{
          position: 'absolute', top: 10, left: 10,
          background: 'var(--overlay-bg)', color: 'var(--green)',
          padding: '4px 10px', borderRadius: 12, fontSize: 11,
          pointerEvents: 'none', border: '1px solid var(--overlay-border)'
        }}>
          🚌 {vehicleCount} live vehicles
        </div>
      )}
      {followedVehicle && (
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(255,215,64,0.15)', color: '#FFD740',
          padding: '4px 12px', borderRadius: 12, fontSize: 11, fontWeight: 600,
          border: '1px solid rgba(255,215,64,0.4)', whiteSpace: 'nowrap',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>Following {CATEGORY_ICON[followedVehicle.category] || '🚌'} {followedVehicle.line}</span>
          <button onClick={() => { followedVehicleIdRef.current = null; setFollowedVehicle(null); onVehicleSelectRef.current?.(null); }} style={{
            background: 'none', border: 'none', color: '#FFD740', cursor: 'pointer',
            fontSize: 13, padding: 0, lineHeight: 1,
          }}>✕</button>
        </div>
      )}
      {!followedVehicle && trackedDeparture && (
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
