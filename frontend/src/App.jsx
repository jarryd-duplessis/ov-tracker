import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Map from './Map';
import DepartureBoard from './DepartureBoard';
import JourneyPlanner from './JourneyPlanner';
import SavedTrips from './SavedTrips';
import TripPanel from './TripPanel';
import BottomSheet from './BottomSheet';
import { useOVWebSocket } from './useOVWebSocket';

const API_BASE = '/api';

function loadSavedTrips() {
  try { return JSON.parse(localStorage.getItem('komt-ie-saved-trips') || '[]'); }
  catch { return []; }
}

function loadTheme() {
  return localStorage.getItem('komt-ie-theme') || 'dark';
}

// Peek content shown when the bottom sheet is collapsed
function PeekBar({ mode, departures, nearbyStops, selectedStop, activeSavedCount, connected }) {
  const nextDep = departures[0];
  const stopName = selectedStop
    ? nearbyStops.find(s => s.tpc === selectedStop)?.name
    : nearbyStops[0]?.name;

  if (mode === 'journey') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Plan a journey</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tap to expand</span>
      </div>
    );
  }

  if (mode === 'saved') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {activeSavedCount > 0 ? `${activeSavedCount} saved trip${activeSavedCount !== 1 ? 's' : ''}` : 'Saved trips'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tap to expand</span>
      </div>
    );
  }

  // Nearby mode
  if (!nextDep) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {stopName || 'Finding stops...'}
        </span>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: connected ? 'var(--green)' : 'var(--red)',
        }} />
      </div>
    );
  }

  const isNow = nextDep.minutesUntil <= 1;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        minWidth: 40, height: 28,
        background: nextDep.transportType === 'TRAM' ? '#FF9800' : nextDep.transportType === 'METRO' ? '#2196F3' : '#4CAF50',
        borderRadius: 'var(--radius-sm)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: 12, color: 'white',
        padding: '0 6px', flexShrink: 0,
      }}>
        {nextDep.line}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {nextDep.destination}
        </div>
      </div>
      <div style={{
        fontSize: isNow ? 16 : 18, fontWeight: 800, flexShrink: 0,
        color: isNow ? 'var(--green)' : 'var(--text)',
        fontVariantNumeric: 'tabular-nums',
        ...(isNow && {
          background: 'var(--green-bg)', padding: '2px 8px',
          borderRadius: 'var(--radius-sm)',
        }),
      }}>
        {isNow ? 'NU' : `${nextDep.minutesUntil}'`}
      </div>
    </div>
  );
}

export default function App() {
  const [userLocation, setUserLocation] = useState(null);
  const [nearbyStops, setNearbyStops] = useState([]);
  const [locationError, setLocationError] = useState(null);
  const [loadingStops, setLoadingStops] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [mode, setMode] = useState('nearby'); // 'nearby' | 'journey' | 'saved'
  const [trackedDeparture, setTrackedDeparture] = useState(null);
  const [selectedStop, setSelectedStop] = useState(null);
  const [journeyRoute, setJourneyRoute] = useState(null);
  const [mapCenter, setMapCenter] = useState(null);
  const [savedTrips, setSavedTrips] = useState(loadSavedTrips);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [theme, setTheme] = useState(loadTheme);
  const [appVisible, setAppVisible] = useState(!document.hidden);
  const watchIdRef = useRef(null);
  const lastStopFetchRef = useRef(null);
  const userSelectedStopRef = useRef(false);
  const nearbyStopsRef = useRef(nearbyStops);
  useEffect(() => { nearbyStopsRef.current = nearbyStops; }, [nearbyStops]);
  const allStopsRef = useRef([]); // Full stop list (not sliced) for KV7 lookup
  const [departureStop, setDepartureStop] = useState(null); // KV7 stop departures come from (may differ from selectedStop)
  const trackedDepartureRef = useRef(null);
  const routeEpochRef = useRef(0);

  // Pause all polling when the tab is hidden (Page Visibility API)
  useEffect(() => {
    const handleVisibility = () => setAppVisible(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const { departures, connected, lastUpdate, error: wsError, subscribe } = useOVWebSocket({ paused: !appVisible });

  const savedIds = useMemo(() => new Set(savedTrips.map(t => t.id)), [savedTrips]);

  const trackedId = trackedDeparture
    ? `${trackedDeparture.stopCode}-${trackedDeparture.journeyNumber}`
    : null;

  // Sync theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('komt-ie-theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }, []);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Fetch nearby stops
  const fetchNearbyStops = useCallback(async (lat, lon, radius = 1.5) => {
    setLoadingStops(true);
    setLocationError(null);
    try {
      const res = await fetch(`${API_BASE}/stops/nearby?lat=${lat}&lon=${lon}&radius=${radius}`);
      if (!res.ok) throw new Error(`Stops fetch failed: ${res.status}`);
      const data = await res.json();
      if (data.stops && data.stops.length > 0) {
        const allStops = data.stops;
        allStopsRef.current = allStops;
        const stops = allStops.slice(0, 8);
        setNearbyStops(stops);
        if (!userSelectedStopRef.current && !trackedDepartureRef.current) {
          // Highlight the nearest stop (first in distance-sorted list)
          setSelectedStop(stops[0].tpc);
          // Subscribe to the nearest KV7 stop (≥8 digit TPC) for departures —
          // only KV7 stops return data from OVapi.
          const nearestKv7 = allStops.find(s => s.tpc && s.tpc.length >= 8);
          if (nearestKv7) {
            setDepartureStop(nearestKv7);
            subscribe([nearestKv7.tpc], { immediate: true });
          }
        }
      }
    } catch (e) {
      console.error('Error fetching stops:', e);
      setLocationError('Could not load nearby stops');
    } finally {
      setLoadingStops(false);
    }
  }, [subscribe]);

  // Request user location
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported');
      return;
    }
    setLocationError(null);
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        setUserLocation({ lat, lon });
        const last = lastStopFetchRef.current;
        if (!userSelectedStopRef.current &&
            (!last || Math.hypot((lat - last.lat) * 111000, (lon - last.lon) * Math.cos(lat * Math.PI / 180) * 111000) > 100)) {
          lastStopFetchRef.current = { lat, lon };
          fetchNearbyStops(lat, lon);
        }
      },
      () => {
        setLocationError('Location access denied');
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
  }, [fetchNearbyStops]);

  useEffect(() => {
    requestLocation();
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [requestLocation]);

  // Journey selection
  const handleSelectJourney = useCallback((it) => {
    setJourneyRoute(it);
    setSelectedVehicle(null);
    setTrackedDeparture(null);
    const firstTransit = it.legs.find(l => l.mode !== 'WALK');
    if (firstTransit?.from?.lat != null) {
      setMapCenter({ lat: firstTransit.from.lat, lon: firstTransit.from.lon, t: Date.now() });
    }
  }, []);

  // Find nearest KV7 stop from a list
  const findNearestKv7 = useCallback((lat, lon, stops) => {
    let best = null, bestDist = Infinity;
    for (const s of stops) {
      if (!s.tpc || s.tpc.length < 8) continue;
      const d = Math.hypot((s.lat - lat) * 111, (s.lon - lon) * 68);
      if (d < bestDist) { best = s; bestDist = d; }
    }
    return best;
  }, []);

  // Subscribe to a KV7 stop for departures
  const subscribeTo = useCallback((kv7Stop) => {
    if (kv7Stop) {
      setDepartureStop(kv7Stop);
      subscribe([kv7Stop.tpc], { immediate: true });
    } else {
      setDepartureStop(null);
      subscribe([], { immediate: true });
    }
  }, [subscribe]);

  // Stop click
  const handleStopClick = useCallback((stop) => {
    routeEpochRef.current++;
    userSelectedStopRef.current = true;
    trackedDepartureRef.current = null;
    setSelectedStop(stop.tpc);
    setSelectedVehicle(null);
    setTrackedDeparture(null);
    setJourneyRoute(null);
    setMode('nearby');
    setMapCenter({ lat: stop.lat, lon: stop.lon, t: Date.now() });

    // 8-digit TPC — subscribe directly
    if (stop.tpc && stop.tpc.length >= 8) {
      subscribeTo(stop);
      return;
    }

    // 7-digit TPC — always fetch stops near the clicked location to find KV7 stops.
    // allStopsRef may be centered elsewhere and miss KV7 stops near this stop.
    fetch(`${API_BASE}/stops/nearby?lat=${stop.lat}&lon=${stop.lon}&radius=1.5`)
      .then(r => r.json())
      .then(data => {
        if (!data.stops) return;
        allStopsRef.current = data.stops;
        subscribeTo(findNearestKv7(stop.lat, stop.lon, data.stops));
      })
      .catch(() => subscribeTo(null));
  }, [subscribe, findNearestKv7, subscribeTo]);

  // Tracking
  const handleTrack = useCallback((dep) => {
    trackedDepartureRef.current = dep;
    setTrackedDeparture(dep);
    if (dep) setMode('nearby');
  }, []);

  const handleVehicleSelect = useCallback((vehicle) => {
    routeEpochRef.current++;
    trackedDepartureRef.current = null;
    setSelectedVehicle(vehicle);
    setJourneyRoute(null);
    setTrackedDeparture(null);
  }, []);

  // Fetch and draw route shape for tracked departure using the trip API.
  // We find the matching vehicle from the live feed to get the correct GTFS-RT
  // operator/route codes (OVapi uses different operator codes than GTFS-RT).
  useEffect(() => {
    if (!trackedDeparture) { setJourneyRoute(null); return; }
    const epoch = routeEpochRef.current;
    const controller = new AbortController();

    (async () => {
      try {
        // Find the matching vehicle in the live feed by journey number + line + proximity
        const vRes = await fetch('/api/vehicles', { signal: controller.signal });
        const vData = vRes.ok ? await vRes.json() : { vehicles: [] };
        const jn = String(trackedDeparture.journeyNumber);
        // Get the departure stop's coordinates for proximity filtering
        const depStop = allStopsRef.current.find(s => s.tpc === trackedDeparture.stopCode)
          || nearbyStopsRef.current.find(s => s.tpc === trackedDeparture.stopCode);
        const depLat = depStop?.lat;
        const depLon = depStop?.lon;

        // Find nearest vehicle: exact journey match first, then any same-line vehicle nearby
        const findNearest = (list) => {
          if (list.length === 0) return null;
          if (list.length === 1 || depLat == null) return list[0];
          return list.reduce((best, v) => {
            const dB = Math.hypot((best.lat - depLat) * 111, (best.lon - depLon) * 68);
            const dV = Math.hypot((v.lat - depLat) * 111, (v.lon - depLon) * 68);
            return dV < dB ? v : best;
          });
        };
        const rejectFar = (v) => {
          if (!v || depLat == null) return v;
          return Math.hypot((v.lat - depLat) * 111, (v.lon - depLon) * 68) <= 30 ? v : null;
        };

        // 1. Try exact journey number match
        let vehicle = rejectFar(findNearest(
          (vData.vehicles || []).filter(v =>
            v.id.endsWith(`:${jn}`) && (!trackedDeparture.line || v.line === trackedDeparture.line)
          )
        ));

        // 2. Fallback: any vehicle on the same line nearby (route shape is the same)
        if (!vehicle && trackedDeparture.line) {
          vehicle = rejectFar(findNearest(
            (vData.vehicles || []).filter(v => v.line === trackedDeparture.line)
          ));
        }
        if (routeEpochRef.current !== epoch) return;

        // Fetch trip data from the matched vehicle
        let tData = null;
        if (vehicle) {
          const params = new URLSearchParams({ vehicleId: vehicle.id });
          if (vehicle.line) params.set('line', vehicle.line);
          const tRes = await fetch(`/api/trip?${params}`, { signal: controller.signal });
          tData = await tRes.json();
        }
        if (routeEpochRef.current !== epoch) return;
        if (!tData || tData.error || !tData.stops || tData.stops.length < 2) return;

        const coords = tData.shape && tData.shape.length >= 2
          ? tData.shape
          : tData.stops.map(s => [s.lon, s.lat]);
        const colour = trackedDeparture.transportType === 'TRAM' ? '#FF9800'
          : trackedDeparture.transportType === 'METRO' ? '#2196F3' : '#4CAF50';
        const isExactVehicle = vehicle && vehicle.id.endsWith(`:${jn}`);
        setJourneyRoute({
          _rawCoords: coords,
          _colour: colour,
          _stops: tData.stops,
          _headsign: tData.headsign,
          _vehicleId: vehicle?.id || null, // for highlighting the vehicle on the map
          _isExactVehicle: isExactVehicle, // only show progress line for exact match
          _journeyNum: jn, // for matching the exact vehicle if it appears later
          _line: trackedDeparture.line,
          _departureStopCode: trackedDeparture.stopCode,
          _delay: trackedDeparture.delay || 0,
          _status: trackedDeparture.status || 'UNKNOWN',
          legs: [],
        });
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('Trip route fetch failed:', e);
      }
    })();

    return () => controller.abort();
  }, [trackedDeparture]);

  // Saving
  const handleToggleSave = useCallback((dep) => {
    const id = `${dep.stopCode}-${dep.journeyNumber}`;
    setSavedTrips(prev => {
      let next;
      if (prev.find(t => t.id === id)) {
        next = prev.filter(t => t.id !== id);
      } else {
        const stop = nearbyStops.find(s => s.tpc === dep.stopCode);
        next = [...prev, { ...dep, id, stopName: stop?.name || dep.stopCode }];
      }
      localStorage.setItem('komt-ie-saved-trips', JSON.stringify(next));
      return next;
    });
  }, [nearbyStops]);

  const handleUnsave = useCallback((id) => {
    setSavedTrips(prev => {
      const next = prev.filter(t => t.id !== id);
      localStorage.setItem('komt-ie-saved-trips', JSON.stringify(next));
      return next;
    });
  }, []);

  const activeSavedCount = savedTrips.filter(
    t => Math.round((new Date(t.expectedTime) - Date.now()) / 60000) > -3
  ).length;

  // Sidebar content (shared between desktop and mobile bottom sheet)
  const sidebarContent = (
    <>
      {selectedVehicle && (
        <TripPanel vehicle={selectedVehicle} onClose={() => handleVehicleSelect(null)} />
      )}
      {!selectedVehicle && mode === 'nearby' && (
        <DepartureBoard
          departures={departures}
          nearbyStops={nearbyStops}
          selectedStop={selectedStop}
          departureStop={departureStop}
          lastUpdate={lastUpdate}
          loading={loadingStops}
          connected={connected}
          trackedId={trackedId}
          savedIds={savedIds}
          onTrack={handleTrack}
          onToggleSave={handleToggleSave}
          onStopClick={handleStopClick}
        />
      )}
      <div style={{ display: !selectedVehicle && mode === 'journey' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
        <JourneyPlanner onSelectJourney={handleSelectJourney} userLocation={userLocation} />
      </div>
      {!selectedVehicle && mode === 'saved' && (
        <SavedTrips
          savedTrips={savedTrips}
          onUnsave={handleUnsave}
          onTrack={handleTrack}
          trackedId={trackedId}
        />
      )}
    </>
  );

  // Mode tabs component
  const modeTabs = (
    <div style={{
      display: 'flex', gap: 2,
      background: 'var(--bg-surface)',
      borderRadius: 'var(--radius-lg)',
      padding: 3,
    }}>
      {[
        ['nearby', 'Nearby'],
        ['journey', 'Plan'],
        ['saved', activeSavedCount > 0 ? `Saved (${activeSavedCount})` : 'Saved'],
      ].map(([m, label]) => (
        <button key={m} onClick={() => {
          setMode(m);
          // Clear route/tracking when switching away from the current context
          if (m !== mode) {
            trackedDepartureRef.current = null;
            setJourneyRoute(null);
            setTrackedDeparture(null);
          }
        }} style={{
          padding: isMobile ? '7px 14px' : '6px 16px',
          borderRadius: 'var(--radius-md)',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          background: mode === m ? 'var(--accent)' : 'transparent',
          color: mode === m ? '#000' : 'var(--text-secondary)',
          whiteSpace: 'nowrap',
          boxShadow: mode === m ? 'var(--shadow-sm)' : 'none',
        }}>
          {label}
        </button>
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
        {/* Compact mobile top bar */}
        <div style={{
          background: 'var(--bg-card)',
          borderBottom: '1px solid var(--border)',
          padding: '6px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          zIndex: 30,
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>🚌</span>
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: connected ? 'var(--green)' : 'var(--red)',
              animation: connected ? 'none' : 'pulse 1.5s infinite',
            }} />
          </div>

          {modeTabs}

          <button onClick={toggleTheme} style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-full)',
            width: 32, height: 32,
            cursor: 'pointer',
            fontSize: 13,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>

        {/* Error banner */}
        {(locationError || wsError) && (
          <div style={{
            background: 'var(--red-bg)', color: 'var(--red)',
            padding: '6px 12px', fontSize: 11, fontWeight: 500,
            textAlign: 'center', borderBottom: '1px solid var(--border)',
            zIndex: 25,
          }}>
            {locationError || wsError}
            {locationError && (
              <button onClick={requestLocation} style={{
                background: 'none', border: 'none', color: 'var(--orange)',
                fontSize: 11, fontWeight: 700, cursor: 'pointer', marginLeft: 8,
              }}>
                Retry
              </button>
            )}
          </div>
        )}

        {/* Full-screen map with bottom sheet overlay */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <Map
            theme={theme}
            userLocation={userLocation}
            nearbyStops={nearbyStops}
            selectedStop={selectedStop}
            departures={departures}
            onMapMove={({ lat, lon, radius, isPan }) => {
              if (isPan) userSelectedStopRef.current = false;
              fetchNearbyStops(lat, lon, radius);
            }}
            onFollowVehicle={({ lat, lon }) => fetchNearbyStops(lat, lon, 0.4)}
            onStopClick={handleStopClick}
            onVehicleSelect={handleVehicleSelect}
            selectedVehicle={selectedVehicle}
            centerOn={mapCenter}
            journeyRoute={journeyRoute}
            trackedDeparture={trackedDeparture}
            appVisible={appVisible}
          />
          <BottomSheet
            peekContent={
              <PeekBar
                mode={mode}
                departures={departures}
                nearbyStops={nearbyStops}
                selectedStop={selectedStop}
                activeSavedCount={activeSavedCount}
                connected={connected}
              />
            }
          >
            {sidebarContent}
          </BottomSheet>
        </div>
      </div>
    );
  }

  // Desktop layout
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      {/* Desktop top bar */}
      <div style={{
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
        padding: '8px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        zIndex: 10,
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>🚌</span>
            <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-0.5px', color: 'var(--text)' }}>
              Komt ie?
            </span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 'var(--radius-full)',
            background: connected ? 'var(--green-bg)' : 'var(--red-bg)',
            fontSize: 11, fontWeight: 600,
            color: connected ? 'var(--green)' : 'var(--red)',
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: connected ? 'var(--green)' : 'var(--red)',
              animation: connected ? 'none' : 'pulse 1.5s infinite',
            }} />
            {connected ? 'Live' : 'Offline'}
          </div>
        </div>

        {modeTabs}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button onClick={toggleTheme} style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-full)',
            width: 34, height: 34,
            cursor: 'pointer', fontSize: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary)',
          }}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          {locationError && (
            <button onClick={requestLocation} style={{
              padding: '7px 14px',
              background: 'var(--orange)', color: '#000',
              border: 'none', borderRadius: 'var(--radius-full)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
              📍 Enable location
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {(locationError || wsError) && (
        <div style={{
          background: 'var(--red-bg)', color: 'var(--red)',
          padding: '8px 16px', fontSize: 12, fontWeight: 500,
          textAlign: 'center', borderBottom: '1px solid var(--border)',
        }}>
          {locationError || wsError}
        </div>
      )}

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
        <div style={{ flex: '1 1 60%', position: 'relative' }}>
          <Map
            theme={theme}
            userLocation={userLocation}
            nearbyStops={nearbyStops}
            selectedStop={selectedStop}
            departures={departures}
            onMapMove={({ lat, lon, radius, isPan }) => {
              if (isPan) userSelectedStopRef.current = false;
              fetchNearbyStops(lat, lon, radius);
            }}
            onFollowVehicle={({ lat, lon }) => fetchNearbyStops(lat, lon, 0.4)}
            onStopClick={handleStopClick}
            onVehicleSelect={handleVehicleSelect}
            selectedVehicle={selectedVehicle}
            centerOn={mapCenter}
            journeyRoute={journeyRoute}
            trackedDeparture={trackedDeparture}
            appVisible={appVisible}
          />
        </div>
        <div style={{
          flex: '0 0 400px',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          borderLeft: '1px solid var(--border)',
          background: 'var(--bg-card)',
        }}>
          {sidebarContent}
        </div>
      </div>
    </div>
  );
}
