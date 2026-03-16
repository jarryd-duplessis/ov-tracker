import { useState, useEffect } from 'react';

const TYPE_ICON = { BUS: '🚌', TRAM: '🚊', METRO: '🚇' };
const TYPE_COLOUR = { BUS: '#4CAF50', TRAM: '#FF9800', METRO: '#2196F3' };

function formatCountdown(expectedTime) {
  const mins = Math.round((new Date(expectedTime) - Date.now()) / 60000);
  if (mins < -2) return 'Departed';
  if (mins <= 0) return 'NU';
  return `${mins} min`;
}

export default function SavedTrips({ savedTrips, onUnsave, onTrack, trackedId }) {
  // Tick every 30s to refresh countdowns
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  if (savedTrips.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#555', fontSize: 13 }}>
        No saved trips.<br />
        <span style={{ marginTop: 8, display: 'block', color: '#444' }}>
          Tap ⭐ on any departure to save it here.
        </span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {savedTrips.map(trip => {
        const cd = formatCountdown(trip.expectedTime);
        const departed = cd === 'Departed';
        const isNow = cd === 'NU';
        const isTracked = trackedId === trip.id;
        const icon = TYPE_ICON[trip.transportType] || '🚌';
        const colour = TYPE_COLOUR[trip.transportType] || '#888';
        const time = new Date(trip.expectedTime).toLocaleTimeString('nl-NL', {
          hour: '2-digit', minute: '2-digit'
        });

        return (
          <div key={trip.id} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: '1px solid #1e2130',
            borderLeft: isTracked ? '3px solid #4FC3F7' : '3px solid transparent',
            background: isTracked ? 'rgba(79,195,247,0.05)' : 'transparent',
            opacity: departed ? 0.45 : 1,
            transition: 'opacity 0.3s',
          }}>
            {/* Line badge */}
            <div style={{
              minWidth: 44, height: 36, background: colour, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 800, fontSize: 14, color: 'white', flexShrink: 0
            }}>
              {icon} {trip.line}
            </div>

            {/* Destination + stop */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontWeight: 600, fontSize: 14, color: '#e8eaed',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {trip.destination}
              </div>
              <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                🚏 {trip.stopName} · {time}
              </div>
            </div>

            {/* Countdown */}
            <div style={{
              textAlign: 'right', flexShrink: 0,
              fontSize: isNow ? 20 : 14,
              fontWeight: 800,
              color: isNow ? '#4CAF50' : departed ? '#555' : '#e8eaed',
              minWidth: 52,
            }}>
              {cd}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
              {!departed && (
                <button
                  onClick={() => onTrack(isTracked ? null : trip)}
                  style={{
                    background: isTracked ? '#4FC3F7' : '#1e2130',
                    border: 'none', borderRadius: 6, padding: '4px 8px',
                    color: isTracked ? '#000' : '#888',
                    fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isTracked ? '📍 On' : '📍 Track'}
                </button>
              )}
              <button
                onClick={() => onUnsave(trip.id)}
                style={{
                  background: '#1e2130', border: 'none', borderRadius: 6,
                  padding: '4px 8px', color: '#666', fontSize: 11, cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
