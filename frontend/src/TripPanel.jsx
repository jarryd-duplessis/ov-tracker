import { useState, useEffect } from 'react';

const MODE_COLOR = {
  BUS: '#4CAF50', TRAM: '#FF9800', SUBWAY: '#2196F3', METRO: '#2196F3',
  RAIL: '#9C27B0', FERRY: '#00BCD4',
};

const MODE_ICON = {
  BUS: '🚌', TRAM: '🚊', SUBWAY: '🚇', METRO: '🚇', RAIL: '🚆', FERRY: '⛴️',
};

function fmt(timeStr) {
  return timeStr ? timeStr.slice(0, 5) : '';
}

export default function TripPanel({ vehicle, onClose }) {
  const [trip, setTrip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!vehicle) return;
    setLoading(true);
    setError(null);
    setTrip(null);

    const controller = new AbortController();
    const params = new URLSearchParams({ vehicleId: vehicle.id });
    if (vehicle.line) params.set('line', vehicle.line);
    fetch(`/api/trip?${params}`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setTrip(data);
      })
      .catch(e => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [vehicle?.id]);

  const color = MODE_COLOR[vehicle?.category] || '#4CAF50';
  const icon = MODE_ICON[vehicle?.category] || '🚌';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-card)',
      animation: 'fadeIn 0.2s ease',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            minWidth: 44, height: 32, background: color,
            borderRadius: 'var(--radius-sm)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 12, color: 'white',
            padding: '0 8px', gap: 3, boxShadow: 'var(--shadow-sm)',
            flexShrink: 0,
          }}>
            {icon} {vehicle?.line}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontWeight: 700, fontSize: 13, color: 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {trip?.headsign || 'Loading...'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
              {vehicle?.category}
            </div>
          </div>
        </div>
        <button onClick={onClose} style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-full)',
          width: 32, height: 32, cursor: 'pointer', fontSize: 13,
          color: 'var(--text-secondary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          ✕
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
        {loading && (
          <div style={{
            padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <div style={{
              width: 20, height: 20, border: '2.5px solid var(--border)',
              borderTopColor: color, borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }} />
            Loading stops...
          </div>
        )}
        {error && (
          <div style={{
            padding: 14, margin: '0 14px',
            background: 'var(--red-bg)', borderRadius: 'var(--radius-md)',
            color: 'var(--red)', fontSize: 12,
          }}>
            {error}
          </div>
        )}
        {trip && trip.stops && (
          <div style={{ padding: '0 14px' }}>
            {trip.stops.map((stop, i) => {
              const isFirst = i === 0;
              const isLast = i === trip.stops.length - 1;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'stretch' }}>
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    width: 20, flexShrink: 0,
                  }}>
                    <div style={{
                      width: 2, flex: isFirst ? '0 0 6px' : '1 1 0',
                      background: isFirst ? 'transparent' : color,
                      opacity: 0.5,
                    }} />
                    <div style={{
                      width: isFirst || isLast ? 10 : 6,
                      height: isFirst || isLast ? 10 : 6,
                      borderRadius: '50%',
                      background: isFirst || isLast ? color : 'var(--bg-card)',
                      border: `2px solid ${color}`,
                      flexShrink: 0,
                      boxShadow: isFirst || isLast ? `0 0 0 3px ${color}22` : 'none',
                    }} />
                    <div style={{
                      width: 2, flex: isLast ? '0 0 6px' : '1 1 0',
                      background: isLast ? 'transparent' : color,
                      opacity: 0.5,
                    }} />
                  </div>
                  <div style={{
                    paddingLeft: 10, paddingTop: 1,
                    paddingBottom: isLast ? 0 : 10,
                    flex: 1, minWidth: 0,
                  }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'baseline', gap: 6,
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'baseline', gap: 4,
                        minWidth: 0, overflow: 'hidden',
                      }}>
                        <span style={{
                          fontSize: isFirst || isLast ? 12 : 11,
                          fontWeight: isFirst || isLast ? 700 : 400,
                          color: isFirst || isLast ? 'var(--text)' : 'var(--text-secondary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {stop.name}
                        </span>
                        {stop.platform && (
                          <span style={{
                            fontSize: 9, color: 'var(--text-muted)', fontWeight: 600,
                            background: 'var(--bg-surface)', padding: '1px 4px',
                            borderRadius: 3, border: '1px solid var(--border)',
                            flexShrink: 0, whiteSpace: 'nowrap',
                          }}>
                            P{stop.platform}
                          </span>
                        )}
                      </div>
                      <span style={{
                        fontSize: 11, flexShrink: 0,
                        fontWeight: isFirst || isLast ? 600 : 400,
                        color: isFirst || isLast ? 'var(--text)' : 'var(--text-muted)',
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {fmt(stop.dep || stop.arr)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      {trip && trip.stops && trip.stops.length > 0 && (
        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          fontSize: 11, color: 'var(--text-muted)',
          display: 'flex', justifyContent: 'space-between',
          fontVariantNumeric: 'tabular-nums',
        }}>
          <span>{trip.stops.length} stops</span>
          <span>
            {fmt(trip.stops[0].dep)} → {fmt(trip.stops[trip.stops.length - 1].arr)}
          </span>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
