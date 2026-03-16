import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Map from './Map';
import DepartureBoard from './DepartureBoard';
import JourneyPlanner from './JourneyPlanner';
import SavedTrips from './SavedTrips';
import { useOVWebSocket } from './useOVWebSocket';

const API_BASE = '/api';

function loadSavedTrips() {
  try { return JSON.parse(localStorage.getItem('komt-ie-saved-trips') || '[]'); }
  catch { return []; }
}

export default function App() {
  const [userLocation, setUserLocation] = useState(null);
  const [nearbyStops, setNearbyStops] = useState([]);
  const [locationError, setLocationError] = useState(null);
  const [loadingStops, setLoadingStops] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [mode, setMode] = useState('nearby'); // 'nearby' | 'journey' | 'saved'
  const [trackedDeparture, setTrackedDeparture] = useState(null);
  const [savedTrips, setSavedTrips] = useState(loadSavedTrips);
  const watchIdRef = useRef(null);
  const lastStopFetchRef = useRef(null); // { lat, lon } of last fetchNearbyStops call

  const { departures, connected, lastUpdate, error: wsError, subscribe } = useOVWebSocket();

  // IDs of saved trips for fast lookup
  const savedIds = useMemo(() => new Set(savedTrips.map(t => t.id)), [savedTrips]);

  // Tracked departure id for the departure board
  const trackedId = trackedDeparture
    ? `${trackedDeparture.stopCode}-${trackedDeparture.journeyNumber}`
    : null;

  // Handle window resize for responsive layout
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Fetch nearby stops when location changes
  const fetchNearbyStops = useCallback(async (lat, lon) => {
    const radius = 1.5;
    setLoadingStops(true);
    try {
      const res = await fetch(`${API_BASE}/stops/nearby?lat=${lat}&lon=${lon}&radius=${radius}`);
      if (!res.ok) throw new Error(`Stops fetch failed: ${res.status}`);
      const data = await res.json();

      if (data.stops && data.stops.length > 0) {
        setNearbyStops(data.stops);
        const stopCodes = data.stops.map(s => s.tpc);
        subscribe(stopCodes);
      }
      // Don't clear existing stops on an empty result — the user hasn't moved to a
      // genuinely stop-free area, the radius just didn't reach the nearest stop.
    } catch (e) {
      console.error('Error fetching stops:', e);
    } finally {
      setLoadingStops(false);
    }
  }, [subscribe]);

  // Request user location
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported by your browser');
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
        // Only re-fetch stops if we've moved more than 100m from the last fetch
        const last = lastStopFetchRef.current;
        if (!last || Math.hypot(lat - last.lat, (lon - last.lon) * Math.cos(lat * Math.PI / 180)) * 111000 > 100) {
          lastStopFetchRef.current = { lat, lon };
          fetchNearbyStops(lat, lon);
        }
      },
      (err) => {
        setLocationError('Location access denied. Please enable location.');
        console.error('Geolocation error:', err);
      },
      { enableHighAccuracy: true, maximumAge: 10000 }
    );
  }, [fetchNearbyStops]);

  // Auto-request location on mount; clear watch on unmount
  useEffect(() => {
    requestLocation();
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [requestLocation]);

  // ── Trip tracking ────────────────────────────────────────────────────────
  const handleTrack = useCallback((dep) => {
    setTrackedDeparture(dep);
    // Switch to nearby view so the map is visible
    if (dep) setMode('nearby');
  }, []);

  // ── Trip saving ──────────────────────────────────────────────────────────
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

  // Count active saved trips (not yet departed) for the tab badge
  const activeSavedCount = savedTrips.filter(
    t => Math.round((new Date(t.expectedTime) - Date.now()) / 60000) > -3
  ).length;

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{
        background: '#0f1117',
        borderBottom: '1px solid #1e2130',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        zIndex: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>🚌</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.3px' }}>
              Komt ie?
            </div>
            <div style={{ fontSize: 10, color: '#555' }}>
              Live Dutch OV tracker
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              ['nearby', '🚏 Nearby'],
              ['journey', '🗺 Plan'],
              ['saved', activeSavedCount > 0 ? `⭐ Saved (${activeSavedCount})` : '⭐ Saved'],
            ].map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: '5px 12px',
                borderRadius: 20,
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 600,
                background: mode === m ? '#4FC3F7' : '#1e2130',
                color: mode === m ? '#000' : '#888',
              }}>
                {label}
              </button>
            ))}
          </div>

          {/* Connection status */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            color: connected ? '#4CAF50' : '#FF5252'
          }}>
            <div style={{
              width: 7, height: 7,
              borderRadius: '50%',
              background: connected ? '#4CAF50' : '#FF5252'
            }} />
            {connected ? 'Live' : 'Connecting...'}
          </div>

          {/* Location button */}
          {locationError && (
            <button
              onClick={requestLocation}
              style={{
                padding: '5px 12px',
                background: '#FF9800',
                color: '#000',
                border: 'none',
                borderRadius: 20,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              📍 Enable location
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {(locationError || wsError) && (
        <div style={{
          background: '#FF5252',
          color: 'white',
          padding: '6px 16px',
          fontSize: 12,
          textAlign: 'center'
        }}>
          {locationError || wsError}
        </div>
      )}

      {/* Main content */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        overflow: 'hidden'
      }}>
        {/* Map — always rendered so vehicle tracking stays live */}
        <div style={{
          flex: isMobile ? '0 0 45%' : '1 1 60%',
          position: 'relative',
          display: mode === 'journey' ? 'none' : 'block',
        }}>
          <Map
            userLocation={userLocation}
            nearbyStops={nearbyStops}
            departures={departures}
            onMapMove={({ lat, lon }) => fetchNearbyStops(lat, lon)}
            trackedDeparture={trackedDeparture}
          />
        </div>

        {/* Sidebar */}
        <div style={{
          flex: isMobile ? '1 1 55%' : '0 0 380px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          borderLeft: isMobile ? 'none' : '1px solid #1e2130',
          borderTop: isMobile ? '1px solid #1e2130' : 'none'
        }}>
          {mode === 'nearby' && (
            <DepartureBoard
              departures={departures}
              nearbyStops={nearbyStops}
              lastUpdate={lastUpdate}
              loading={loadingStops}
              connected={connected}
              trackedId={trackedId}
              savedIds={savedIds}
              onTrack={handleTrack}
              onToggleSave={handleToggleSave}
            />
          )}
          {mode === 'journey' && <JourneyPlanner />}
          {mode === 'saved' && (
            <SavedTrips
              savedTrips={savedTrips}
              onUnsave={handleUnsave}
              onTrack={handleTrack}
              trackedId={trackedId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
