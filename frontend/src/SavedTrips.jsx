import { useState, useEffect } from 'react';

const TYPE_ICON = { BUS: '🚌', TRAM: '🚊', METRO: '🚇' };
const TYPE_COLOUR = { BUS: '#4CAF50', TRAM: '#FF9800', METRO: '#2196F3' };

function formatCountdown(expectedTime) {
  const mins = Math.round((new Date(expectedTime) - Date.now()) / 60000);
  if (mins < -2) return 'Departed';
  if (mins <= 0) return 'NU';
  return `${mins}'`;
}

export default function SavedTrips({ savedTrips, onUnsave, onTrack, trackedId }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  if (savedTrips.length === 0) {
    return (
      <div style={{
        padding: 48, textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 28, opacity: 0.3 }}>⭐</span>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No saved trips</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, opacity: 0.7 }}>
          Tap the star on any departure to save it
        </div>
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
            borderBottom: '1px solid var(--border)',
            borderLeft: isTracked ? '3px solid var(--accent)' : '3px solid transparent',
            background: isTracked ? 'var(--accent-bg)' : 'transparent',
            opacity: departed ? 0.35 : 1,
            transition: 'opacity 0.3s, background 0.2s',
            padding: '12px 14px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Line badge */}
              <div style={{
                minWidth: 42, height: 30, background: colour,
                borderRadius: 'var(--radius-sm)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 12, color: 'white', flexShrink: 0,
                gap: 3, boxShadow: 'var(--shadow-sm)',
              }}>
                {icon} {trip.line}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontWeight: 600, fontSize: 13, color: 'var(--text)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {trip.destination}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                  {trip.stopName} · {time}
                </div>
              </div>

              {/* Countdown */}
              <div style={{
                flexShrink: 0, minWidth: 44, textAlign: 'right',
                fontSize: isNow ? 16 : 18, fontWeight: 800,
                fontVariantNumeric: 'tabular-nums',
                color: isNow ? 'var(--green)' : departed ? 'var(--text-muted)' : 'var(--text)',
                ...(isNow && {
                  background: 'var(--green-bg)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-sm)',
                }),
              }}>
                {cd}
              </div>
            </div>

            {/* Actions — horizontal */}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {!departed && (
                <button onClick={() => onTrack(isTracked ? null : trip)} style={{
                  flex: 1,
                  background: isTracked ? 'var(--accent)' : 'var(--bg-surface)',
                  border: `1px solid ${isTracked ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)', padding: '6px 12px',
                  color: isTracked ? '#000' : 'var(--text-secondary)',
                  fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}>
                  {isTracked ? '📍 Tracking' : '📍 Track'}
                </button>
              )}
              <button onClick={() => onUnsave(trip.id)} style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '6px 12px', color: 'var(--text-muted)',
                fontSize: 11, cursor: 'pointer',
              }}>
                Remove
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
