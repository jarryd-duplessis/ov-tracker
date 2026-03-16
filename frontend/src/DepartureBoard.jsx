import { useState } from 'react';

const TYPE_ICON = {
  BUS: '🚌',
  TRAM: '🚊',
  METRO: '🚇',
};

const TYPE_COLOUR = {
  BUS: '#4CAF50',
  TRAM: '#FF9800',
  METRO: '#2196F3',
};

function ConfidenceBadge({ confidence }) {
  const isLive = confidence === 'live';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 10,
      padding: '2px 6px',
      borderRadius: 10,
      background: isLive ? 'rgba(76,175,80,0.15)' : 'rgba(255,152,0,0.15)',
      color: isLive ? '#4CAF50' : '#FF9800',
      fontWeight: 600,
      letterSpacing: '0.3px'
    }}>
      <span style={{
        width: 6, height: 6,
        borderRadius: '50%',
        background: isLive ? '#4CAF50' : '#FF9800',
        animation: isLive ? 'pulse 1.5s infinite' : 'none'
      }} />
      {isLive ? 'LIVE' : 'SCHEDULED'}
    </span>
  );
}

function DepartureRow({ dep, isTracked, isSaved, onTrack, onToggleSave }) {
  const isNow = dep.minutesUntil <= 1;
  const isSoon = dep.minutesUntil <= 5;
  const colour = TYPE_COLOUR[dep.transportType] || '#888';
  const icon = TYPE_ICON[dep.transportType] || '🚌';

  return (
    <div
      onClick={() => onTrack(isTracked ? null : dep)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderBottom: '1px solid #1e2130',
        borderLeft: isTracked ? '3px solid #4FC3F7' : '3px solid transparent',
        background: isTracked ? 'rgba(79,195,247,0.05)' : 'transparent',
        opacity: dep.minutesUntil < -1 ? 0.4 : 1,
        transition: 'opacity 0.3s, background 0.2s',
        cursor: 'pointer',
      }}
    >
      {/* Line number badge */}
      <div style={{
        minWidth: 44,
        height: 36,
        background: colour,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: 14,
        color: 'white',
        flexShrink: 0
      }}>
        {icon} {dep.line}
      </div>

      {/* Destination */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: 600,
          fontSize: 14,
          color: '#e8eaed',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          {dep.destination}
        </div>
        <div style={{ marginTop: 3 }}>
          <ConfidenceBadge confidence={dep.confidence} />
        </div>
      </div>

      {/* Time */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{
          fontSize: 22,
          fontWeight: 800,
          color: isNow ? '#4CAF50' : isSoon ? '#FF9800' : '#e8eaed',
          lineHeight: 1
        }}>
          {isNow ? 'NU' : `${dep.minutesUntil}'`}
        </div>
        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
          {new Date(dep.expectedTime).toLocaleTimeString('nl-NL', {
            hour: '2-digit', minute: '2-digit'
          })}
        </div>
      </div>

      {/* Save button */}
      <button
        onClick={e => { e.stopPropagation(); onToggleSave(dep); }}
        title={isSaved ? 'Remove from saved' : 'Save trip'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 18, padding: '0 2px', flexShrink: 0,
          color: isSaved ? '#FFD700' : '#333',
          lineHeight: 1,
        }}
      >
        {isSaved ? '★' : '☆'}
      </button>
    </div>
  );
}

export default function DepartureBoard({ departures, nearbyStops, lastUpdate, loading, connected, trackedId, savedIds, onTrack, onToggleSave }) {
  const [filter, setFilter] = useState('ALL');

  const filtered = departures.filter(d => {
    if (filter === 'ALL') return true;
    return d.transportType === filter;
  });

  const types = ['ALL', ...new Set(departures.map(d => d.transportType))];

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#13151e'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #1e2130',
        background: '#0f1117'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e8eaed' }}>
              {nearbyStops.length > 0
                ? `${nearbyStops.length} stop${nearbyStops.length > 1 ? 's' : ''} nearby`
                : 'Locating stops...'}
            </div>
            {lastUpdate && (
              <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>
                Updated {lastUpdate.toLocaleTimeString('nl-NL')}
              </div>
            )}
          </div>
          {loading && (
            <div style={{ fontSize: 11, color: '#555' }}>Loading...</div>
          )}
        </div>

        {/* Stop names */}
        {nearbyStops.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {nearbyStops.map(s => (
              <span key={s.id} style={{
                fontSize: 10,
                padding: '2px 8px',
                background: '#1e2130',
                borderRadius: 10,
                color: '#888'
              }}>
                🚏 {s.name} · {Math.round(s.distance * 1000)}m
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Filter tabs */}
      {types.length > 1 && (
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '8px 16px',
          borderBottom: '1px solid #1e2130'
        }}>
          {types.map(type => (
            <button
              key={type}
              onClick={() => setFilter(type)}
              style={{
                padding: '4px 12px',
                borderRadius: 20,
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 600,
                background: filter === type ? '#4FC3F7' : '#1e2130',
                color: filter === type ? '#000' : '#888',
                transition: 'all 0.2s'
              }}
            >
              {type === 'ALL' ? 'All' : `${TYPE_ICON[type] || ''} ${type}`}
            </button>
          ))}
        </div>
      )}

      {/* Stale data banner during reconnect */}
      {!connected && departures.length > 0 && (
        <div style={{
          padding: '6px 16px',
          background: 'rgba(255,82,82,0.1)',
          borderBottom: '1px solid rgba(255,82,82,0.2)',
          fontSize: 11,
          color: '#FF5252',
          textAlign: 'center'
        }}>
          Reconnecting — data may be stale
        </div>
      )}

      {/* Departure list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && !loading && (
          <div style={{
            padding: 32,
            textAlign: 'center',
            color: '#555',
            fontSize: 13
          }}>
            {nearbyStops.length === 0
              ? '📍 Share your location to find nearby stops'
              : '😔 No departures found in the next hour'}
          </div>
        )}
        {filtered.map(dep => {
          const id = `${dep.stopCode}-${dep.journeyNumber}`;
          return (
            <DepartureRow
              key={id}
              dep={dep}
              isTracked={trackedId === id}
              isSaved={savedIds?.has(id)}
              onTrack={onTrack}
              onToggleSave={onToggleSave}
            />
          );
        })}
      </div>

      {/* Confidence legend */}
      <div style={{
        padding: '8px 16px',
        borderTop: '1px solid #1e2130',
        display: 'flex',
        gap: 16,
        fontSize: 10,
        color: '#555'
      }}>
        <span>🟢 LIVE = vehicle broadcasting position</span>
        <span>🟡 SCHEDULED = timetable only</span>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.3); }
        }
      `}</style>
    </div>
  );
}
