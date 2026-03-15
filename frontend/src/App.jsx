import { useState, useEffect, useCallback } from 'react';
import Map from './Map';
import DepartureBoard from './DepartureBoard';
import JourneyPlanner from './JourneyPlanner';
import { useOVWebSocket } from './useOVWebSocket';

const API_BASE = '/api';

export default function App() {
  const [userLocation, setUserLocation] = useState(null);
  const [nearbyStops, setNearbyStops] = useState([]);
  const [locationError, setLocationError] = useState(null);
  const [loadingStops, setLoadingStops] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [mode, setMode] = useState('nearby'); // 'nearby' | 'journey'

  const { departures, connected, lastUpdate, error: wsError, subscribe } = useOVWebSocket();

  // Handle window resize for responsive layout
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Fetch nearby stops when location changes
  const fetchNearbyStops = useCallback(async (lat, lon) => {
    setLoadingStops(true);
    try {
      const res = await fetch(`${API_BASE}/stops/nearby?lat=${lat}&lon=${lon}&radius=0.5`);
      const data = await res.json();

      if (data.stops && data.stops.length > 0) {
        setNearbyStops(data.stops);
        // Subscribe to departures for these stops via WebSocket
        const stopCodes = data.stops.map(s => s.tpc);
        subscribe(stopCodes);
      } else {
        setNearbyStops([]);
      }
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
    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        setUserLocation({ lat, lon });
        fetchNearbyStops(lat, lon);
      },
      (err) => {
        setLocationError('Location access denied. Please enable location.');
        console.error('Geolocation error:', err);
      },
      { enableHighAccuracy: true, maximumAge: 10000 }
    );
  }, [fetchNearbyStops]);

  // Auto-request location on mount
  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

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
            {[['nearby', '🚏 Nearby'], ['journey', '🗺 Plan']].map(([m, label]) => (
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
        {/* Map */}
        <div style={{
          flex: isMobile ? '0 0 45%' : '1 1 60%',
          position: 'relative'
        }}>
          <Map
            userLocation={userLocation}
            nearbyStops={nearbyStops}
            departures={departures}
            onLocationSelect={({ lat, lon }) => {
              setUserLocation({ lat, lon });
              fetchNearbyStops(lat, lon);
            }}
          />
        </div>

        {/* Sidebar */}
        <div style={{
          flex: isMobile ? '1 1 55%' : '0 0 380px',
          overflow: 'hidden',
          borderLeft: isMobile ? 'none' : '1px solid #1e2130',
          borderTop: isMobile ? '1px solid #1e2130' : 'none'
        }}>
          {mode === 'nearby' ? (
            <DepartureBoard
              departures={departures}
              nearbyStops={nearbyStops}
              lastUpdate={lastUpdate}
              loading={loadingStops}
            />
          ) : (
            <JourneyPlanner />
          )}
        </div>
      </div>
    </div>
  );
}
