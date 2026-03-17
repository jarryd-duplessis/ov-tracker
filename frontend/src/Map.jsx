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
    const coords = data.stops.map(s => [s.lon, s.lat]);
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
function matchesTracked(vehicle, dep) {
  if (!dep) return false;
  if (vehicle.tripId && dep.journeyNumber) {
    if (vehicle.tripId.includes(String(dep.journeyNumber))) return true;
  }
  return false; // don't fall back to line — too broad, matches unrelated vehicles
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

export default function Map({ theme, userLocation, nearbyStops, selectedStop, departures, onMapMove, onFollowVehicle, onStopClick, onVehicleSelect, trackedDeparture, centerOn, journeyRoute }) {
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

  // Switch map tile style when theme changes
  const themeRef = useRef(theme);
  useEffect(() => {
    if (!mapRef.current || theme === themeRef.current) return;
    themeRef.current = theme;
    mapRef.current.setStyle(MAP_STYLES[theme] || MAP_STYLES.dark);
  }, [theme]);

  // Explicit fly-to from parent (e.g. journey planner selects a boarding stop)
  useEffect(() => {
    if (!centerOn || !mapRef.current) return;
mapRef.current.flyTo({ center: [centerOn.lon, centerOn.lat], zoom: 15, speed: 1.2 });
  }, [centerOn]);

  // Draw / clear the tracked departure's route as a GeoJSON line layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const geojson = { type: 'FeatureCollection', features: [] };

    const walkGeojson = { type: 'FeatureCollection', features: [] };

    if (journeyRoute) {
      for (const leg of journeyRoute.legs) {
        if (!leg.legGeometry?.points) {
          // Walk legs without geometry — draw a straight line from/to
          if (leg.mode === 'WALK' && leg.from?.lon != null && leg.to?.lon != null) {
            walkGeojson.features.push({
              type: 'Feature',
              properties: {},
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
              walkGeojson.features.push({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: coords },
              });
            } else {
              geojson.features.push({
                type: 'Feature',
                properties: { color },
                geometry: { type: 'LineString', coordinates: coords },
              });
            }
          }
        } catch { /* malformed polyline — skip */ }
      }
    }

    const apply = () => {
      if (map.getSource('journey-route')) {
        map.getSource('journey-route').setData(geojson);
      } else {
        map.addSource('journey-route', { type: 'geojson', data: geojson });
        const beforeLayer = map.getLayer('road-label') ? 'road-label' : undefined;
        map.addLayer({
          id: 'journey-route-line',
          type: 'line',
          source: 'journey-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 0.85 },
        }, beforeLayer);
      }

      // Walk segments as dashed lines
      if (map.getSource('journey-walk')) {
        map.getSource('journey-walk').setData(walkGeojson);
      } else {
        map.addSource('journey-walk', { type: 'geojson', data: walkGeojson });
        map.addLayer({
          id: 'journey-walk-line',
          type: 'line',
          source: 'journey-walk',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#888', 'line-width': 3, 'line-opacity': 0.7, 'line-dasharray': [2, 3] },
        });
      }

      // Fit map to show the full route (transit + walk)
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

    if (map.isStyleLoaded()) apply();
    else map.once('style.load', apply);
  }, [journeyRoute]);

  // Keep refs current without triggering map re-initialisation
  useEffect(() => { onMapMoveRef.current = onMapMove; }, [onMapMove]);
  useEffect(() => { onFollowVehicleRef.current = onFollowVehicle; }, [onFollowVehicle]);
  useEffect(() => { onStopClickRef.current = onStopClick; }, [onStopClick]);
  useEffect(() => { onVehicleSelectRef.current = onVehicleSelect; }, [onVehicleSelect]);
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
    mapRef.current.on('movestart', (e) => { userInitiatedRef.current = !!e.originalEvent; });

    // Fetch stops for whatever area the user pans to (debounced 600ms, zoom >= 13)
    mapRef.current.on('moveend', () => {
      if (!userInitiatedRef.current) return; // programmatic flyTo — keep current stop subscription
      clearTimeout(moveTimerRef.current);
      moveTimerRef.current = setTimeout(() => {
        const map = mapRef.current;
        if (!map || !onMapMoveRef.current) return;
        if (map.getZoom() < 13) return;
        const c = map.getCenter();
        const ne = map.getBounds().getNorthEast();
        // Half-diagonal of viewport in km — clamp to 1.5km so we don't flood
        // the map with hundreds of stop markers when zoomed out
        const dLat = (ne.lat - c.lat) * Math.PI / 180;
        const dLon = (ne.lng - c.lng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(c.lat*Math.PI/180)**2 * Math.sin(dLon/2)**2;
        const radius = Math.min(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)), 1.5);
        onMapMoveRef.current({ lat: c.lat, lon: c.lng, radius });
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
      const isHighlighted = selectedStop === stop.tpc || trackedDepartureRef.current?.stopCode === stop.tpc;
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
    const allVehiclesRef = { current: [] };
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

    const INTERP_MS = 1500; // interpolation duration to new GPS position
    const DR_MAX_MS = 15000; // max dead reckoning time after interpolation ends

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
            // Phase 1: smooth interpolation to the GPS position
            const raw = elapsed / INTERP_MS;
            const t = raw < 0.5 ? 2 * raw * raw : -1 + (4 - 2 * raw) * raw;
            lon = a.fromLon + (a.toLon - a.fromLon) * t;
            lat = a.fromLat + (a.toLat - a.fromLat) * t;
            active = true;
          } else if (a.speed > 0.5 && elapsed < INTERP_MS + DR_MAX_MS) {
            // Phase 2: dead reckoning along route path (or straight-line fallback)
            const drSec = (elapsed - INTERP_MS) / 1000;
            // Distance in degrees (approximate) — speed is m/s, 1° ≈ 111111m
            const distDeg = (a.speed * drSec) / 111111;

            if (a.routePath && a.routePath.length >= 2) {
              // Route-snapped: find where the GPS position sits on the path, then walk forward
              if (!a._pathPos) {
                a._pathPos = findOnPath(a.toLon, a.toLat, a.routePath);
              }
              const result = walkAlongPath(a.routePath, a._pathPos.segIdx, a._pathPos.t, distDeg);
              lon = result.lon;
              lat = result.lat;
              // Update bearing to follow the route direction
              if (result.bearing != null) {
                a.bearing = result.bearing;
                updateBearing(s.el, result.bearing);
              }
            } else if (a.bearing != null) {
              // Straight-line fallback when no route path available
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
            // Done — vehicle is stationary or dead reckoning expired
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
        const isTracked = matchesTracked(v, tracked);
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
            // Hand off to the shared loop — interpolate to new GPS position,
            // then dead-reckon along route path until the next update
            const anim = {
              fromLat: s.lat, fromLon: s.lon,
              toLat: v.lat, toLon: v.lon,
              speed: v.speed || 0, bearing: v.bearing,
              startTime: performance.now(),
              routePath: routePathsRef.current[v.id] || null,
            };
            animsRef.current[v.id] = anim;

            // Fetch route path if we don't have one yet (non-blocking)
            if (!anim.routePath && !routePathFetchingRef.current.has(v.id)) {
              routePathFetchingRef.current.add(v.id);
              getRoutePath(v).then(coords => {
                routePathFetchingRef.current.delete(v.id);
                if (coords) {
                  routePathsRef.current[v.id] = coords;
                  // Attach to current animation if it's still running
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

      if (trackedVehicle && lastTrackedIdRef.current === null) {
        const tid = `${tracked.stopCode}-${tracked.journeyNumber}`;
        lastTrackedIdRef.current = tid;
        map.flyTo({ center: [trackedVehicle.lon, trackedVehicle.lat], zoom: 15, speed: 1.5 });
      }

      setVehicleCount(visibleIds.size);
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
    const interval = setInterval(fetchVehicles, 2000);
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
