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
  const watchIdRef = useRef(null);
  const lastStopFetchRef = useRef(null);
  const userSelectedStopRef = useRef(false);
  const nearbyStopsRef = useRef(nearbyStops);
  useEffect(() => { nearbyStopsRef.current = nearbyStops; }, [nearbyStops]);
  const routeEpochRef = useRef(0);

  const { departures, connected, lastUpdate, error: wsError, subscribe } = useOVWebSocket();

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
        const stops = data.stops.slice(0, 8);
        setNearbyStops(stops);
        if (!userSelectedStopRef.current) {
          const closestKv7 = stops.find(s => s.tpc && s.tpc.length >= 8);
          if (closestKv7) {
            setSelectedStop(closestKv7.tpc);
            subscribe([closestKv7.tpc], { immediate: true });
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

  // Stop click
  const handleStopClick = useCallback((stop) => {
    routeEpochRef.current++;
    userSelectedStopRef.current = true;
    setSelectedStop(stop.tpc);
    setSelectedVehicle(null);
    setTrackedDeparture(null);
    setJourneyRoute(null);
    setMode('nearby');
    setMapCenter({ lat: stop.lat, lon: stop.lon, t: Date.now() });

    let subscribeTpc = stop.tpc;
    if (!subscribeTpc || subscribeTpc.length < 8) {
      const nearby = nearbyStopsRef.current;
      let best = null, bestDist = Infinity;
      for (const s of nearby) {
        if (!s.tpc || s.tpc.length < 8) continue;
        const d = Math.hypot((s.lat - stop.lat) * 111, (s.lon - stop.lon) * 68);
        if (d < bestDist) { best = s; bestDist = d; }
      }
      subscribeTpc = best?.tpc;
    }
    if (subscribeTpc) subscribe([subscribeTpc], { immediate: true });
  }, [subscribe]);

  // Tracking
  const handleTrack = useCallback((dep) => {
    setTrackedDeparture(dep);
    if (dep) setMode('nearby');
  }, []);

  const handleVehicleSelect = useCallback((vehicle) => {
    routeEpochRef.current++;
    setSelectedVehicle(vehicle);
    setJourneyRoute(null);
    setTrackedDeparture(null);
  }, []);

  // Auto-fetch route for tracked departure
  useEffect(() => {
    if (!trackedDeparture) { setJourneyRoute(null); return; }
    const stop = nearbyStopsRef.current.find(s => s.tpc === trackedDeparture.stopCode);
    if (!stop) return;
    const epoch = routeEpochRef.current;
    const controller = new AbortController();
    fetch(
      `/api/journey?fromLat=${stop.lat}&fromLon=${stop.lon}&to=${encodeURIComponent(trackedDeparture.destination)}`,
      { signal: controller.signal }
    )
      .then(r => r.json())
      .then(data => {
        if (routeEpochRef.current !== epoch) return;
        const it = data.itineraries?.find(it =>
          it.legs.some(l => l.mode !== 'WALK' && l.routeShortName === trackedDeparture.line)
        ) ?? data.itineraries?.[0] ?? null;
        setJourneyRoute(it);
      })
      .catch(e => { if (e.name !== 'AbortError') console.warn('Route fetch failed:', e); });
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
        <TripPanel vehicle={selectedVehicle} onClose={() => setSelectedVehicle(null)} />
      )}
      {!selectedVehicle && mode === 'nearby' && (
        <DepartureBoard
          departures={departures}
          nearbyStops={nearbyStops}
          selectedStop={selectedStop}
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
        <button key={m} onClick={() => setMode(m)} style={{
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
            onMapMove={({ lat, lon, radius }) => {
              userSelectedStopRef.current = false;
              fetchNearbyStops(lat, lon, radius);
            }}
            onFollowVehicle={({ lat, lon }) => fetchNearbyStops(lat, lon, 0.4)}
            onStopClick={handleStopClick}
            onVehicleSelect={handleVehicleSelect}
            centerOn={mapCenter}
            journeyRoute={journeyRoute}
            trackedDeparture={trackedDeparture}
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
            onMapMove={({ lat, lon, radius }) => {
              userSelectedStopRef.current = false;
              fetchNearbyStops(lat, lon, radius);
            }}
            onFollowVehicle={({ lat, lon }) => fetchNearbyStops(lat, lon, 0.4)}
            onStopClick={handleStopClick}
            onVehicleSelect={handleVehicleSelect}
            centerOn={mapCenter}
            journeyRoute={journeyRoute}
            trackedDeparture={trackedDeparture}
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
