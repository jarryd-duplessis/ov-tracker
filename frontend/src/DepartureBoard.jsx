import { useState, useEffect, useMemo } from 'react';

const TYPE_ICON = { BUS: '🚌', TRAM: '🚊', METRO: '🚇' };
const TYPE_COLOUR = { BUS: '#4CAF50', TRAM: '#FF9800', METRO: '#2196F3' };

function DepartureRow({ dep, isTracked, isSaved, onTrack, onToggleSave }) {
  const isNow = dep.minutesUntil <= 1;
  const isSoon = dep.minutesUntil <= 5;
  const departed = dep.minutesUntil < -1;
  const colour = TYPE_COLOUR[dep.transportType] || '#888';
  const icon = TYPE_ICON[dep.transportType] || '🚌';
  const isLive = dep.confidence === 'live';

  // Compute delay
  const delay = (() => {
    if (!dep.expectedTime || !dep.scheduledTime) return 0;
    const exp = new Date(dep.expectedTime).getTime();
    const sched = new Date(dep.scheduledTime).getTime();
    return Math.round((exp - sched) / 60000);
  })();

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      borderLeft: isTracked ? '3px solid var(--accent)' : '3px solid transparent',
      background: isTracked ? 'var(--accent-bg)' : 'transparent',
      opacity: departed ? 0.35 : 1,
      transition: 'opacity 0.3s, background 0.2s',
    }}>
      <div
        onClick={() => onTrack(isTracked ? null : dep)}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px',
          cursor: 'pointer',
        }}
      >
        {/* Line badge */}
        <div style={{
          minWidth: 44, height: 32,
          background: colour, borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: 12, color: 'white', flexShrink: 0,
          gap: 3, boxShadow: 'var(--shadow-sm)',
        }}>
          {icon} {dep.line}
        </div>

        {/* Destination + metadata */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 600, fontSize: 14, color: 'var(--text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {dep.destination}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 3,
            fontSize: 11, color: 'var(--text-muted)',
          }}>
            {/* Live/scheduled dot */}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              color: isLive ? 'var(--green)' : 'var(--text-muted)',
              fontWeight: isLive ? 600 : 400,
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: isLive ? 'var(--green)' : 'var(--text-muted)',
                display: 'inline-block',
                animation: isLive ? 'pulse 1.5s infinite' : 'none',
                opacity: isLive ? 1 : 0.5,
              }} />
              {isLive ? 'live' : 'sched'}
            </span>
            {/* Delay indicator */}
            {delay > 0 && (
              <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                +{delay}'
              </span>
            )}
            {/* Scheduled time */}
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {new Date(dep.expectedTime).toLocaleTimeString('nl-NL', {
                hour: '2-digit', minute: '2-digit'
              })}
            </span>
          </div>
        </div>

        {/* Countdown — the hero element */}
        <div style={{
          textAlign: 'right', flexShrink: 0, minWidth: 48,
        }}>
          <div style={{
            fontSize: isNow ? 20 : 24,
            fontWeight: 800, lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            color: isNow ? 'var(--green)' : isSoon ? 'var(--orange)' : 'var(--text)',
            ...(isNow && {
              background: 'var(--green-bg)',
              padding: '4px 10px',
              borderRadius: 'var(--radius-sm)',
            }),
          }}>
            {departed ? '—' : isNow ? 'NU' : `${dep.minutesUntil}'`}
          </div>
        </div>

        {/* Save star */}
        <button
          onClick={e => { e.stopPropagation(); onToggleSave(dep); }}
          title={isSaved ? 'Remove from saved' : 'Save trip'}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 18, padding: 6, flexShrink: 0,
            color: isSaved ? '#facc15' : 'var(--text-muted)',
            lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: isSaved ? 1 : 0.4,
            transition: 'opacity 0.15s, color 0.15s',
          }}
        >
          {isSaved ? '★' : '☆'}
        </button>
      </div>

      {/* Tracking panel */}
      {isTracked && (
        <div style={{
          padding: '0 14px 12px 14px',
          display: 'flex', alignItems: 'center', gap: 10,
          animation: 'fadeIn 0.2s ease',
        }}>
          <div style={{
            flex: 1, fontSize: 11, color: 'var(--accent)',
            display: 'flex', alignItems: 'center', gap: 5, fontWeight: 500,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%',
              background: 'var(--accent)', display: 'inline-block',
              animation: 'pulse 1.5s infinite',
            }} />
            Route on map
          </div>
          <button
            onClick={e => { e.stopPropagation(); onTrack(null); }}
            style={{
              padding: '5px 12px', borderRadius: 'var(--radius-full)',
              border: '1px solid var(--accent-border)',
              background: 'var(--accent-bg)', color: 'var(--accent)',
              fontSize: 11, cursor: 'pointer', fontWeight: 600,
            }}
          >
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

export default function DepartureBoard({ departures, nearbyStops, selectedStop, lastUpdate, loading, connected, trackedId, savedIds, onTrack, onToggleSave, onStopClick }) {
  const [filter, setFilter] = useState('ALL');
  const types = useMemo(() => ['ALL', ...new Set(departures.map(d => d.transportType))], [departures]);

  useEffect(() => {
    if (filter !== 'ALL' && !types.includes(filter)) setFilter('ALL');
  }, [filter, types]);

  const filtered = departures.filter(d => filter === 'ALL' || d.transportType === filter);

  const stopName = selectedStop
    ? nearbyStops.find(s => s.tpc === selectedStop)?.name || 'Selected stop'
    : nearbyStops.length > 0
      ? `${nearbyStops.length} stop${nearbyStops.length > 1 ? 's' : ''} nearby`
      : 'Locating stops...';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-card)',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {stopName}
            </div>
            {lastUpdate && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                {lastUpdate.toLocaleTimeString('nl-NL')}
              </div>
            )}
          </div>
          {loading && (
            <div style={{
              width: 16, height: 16, border: '2px solid var(--border)',
              borderTopColor: 'var(--accent)', borderRadius: '50%',
              animation: 'spin 0.8s linear infinite', flexShrink: 0,
            }} />
          )}
        </div>

        {/* Stop pills */}
        {nearbyStops.length > 1 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {nearbyStops.slice(0, 5).map(s => {
              const isActive = selectedStop === s.tpc;
              return (
                <span key={s.tpc} onClick={() => onStopClick?.(s)} style={{
                  fontSize: 11, padding: '4px 10px',
                  background: isActive ? 'var(--accent-bg)' : 'var(--bg-surface)',
                  border: `1px solid ${isActive ? 'var(--accent-border)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-full)',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  cursor: 'pointer', fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.15s',
                }}>
                  {s.name}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Filter tabs */}
      {types.length > 2 && (
        <div style={{
          display: 'flex', gap: 6, padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
        }}>
          {types.map(type => (
            <button key={type} onClick={() => setFilter(type)} style={{
              padding: '5px 12px', borderRadius: 'var(--radius-full)',
              border: filter === type ? '1px solid var(--accent-border)' : '1px solid var(--border)',
              cursor: 'pointer', fontSize: 11, fontWeight: 600,
              background: filter === type ? 'var(--accent-bg)' : 'transparent',
              color: filter === type ? 'var(--accent)' : 'var(--text-secondary)',
            }}>
              {type === 'ALL' ? 'All' : `${TYPE_ICON[type] || ''} ${type}`}
            </button>
          ))}
        </div>
      )}

      {/* Stale banner */}
      {!connected && departures.length > 0 && (
        <div style={{
          padding: '6px 14px',
          background: 'var(--red-bg)',
          borderBottom: '1px solid var(--border)',
          fontSize: 11, color: 'var(--red)', textAlign: 'center', fontWeight: 500,
        }}>
          Reconnecting — data may be stale
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && !loading && (
          <div style={{
            padding: 40, textAlign: 'center',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 28, opacity: 0.3 }}>🚏</span>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {nearbyStops.length === 0
                ? 'Share your location to find stops'
                : 'No departures in the next hour'}
            </div>
          </div>
        )}
        {filtered.map(dep => {
          const id = `${dep.stopCode}-${dep.journeyNumber}`;
          return (
            <DepartureRow
              key={id} dep={dep}
              isTracked={trackedId === id}
              isSaved={savedIds?.has(id)}
              onTrack={onTrack}
              onToggleSave={onToggleSave}
            />
          );
        })}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
