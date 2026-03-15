import { useState } from 'react';

const MODE_ICON = {
  WALK: '🚶',
  BUS: '🚌',
  TRAM: '🚊',
  SUBWAY: '🚇',
  METRO: '🚇',
  RAIL: '🚆',
  REGIONAL_FAST_RAIL: '🚆',
  REGIONAL_RAIL: '🚆',
  LONG_DISTANCE: '🚄',
  HIGHSPEED_RAIL: '🚄',
  FERRY: '⛴️',
  BICYCLE: '🚲',
};

const MODE_COLOR = {
  WALK: '#555',
  BUS: '#4CAF50',
  TRAM: '#FF9800',
  SUBWAY: '#2196F3',
  METRO: '#2196F3',
  RAIL: '#9C27B0',
  REGIONAL_FAST_RAIL: '#9C27B0',
  REGIONAL_RAIL: '#9C27B0',
  LONG_DISTANCE: '#E91E63',
  HIGHSPEED_RAIL: '#E91E63',
  FERRY: '#00BCD4',
};

function fmt(isoStr) {
  return new Date(isoStr).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(seconds) {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function LegRow({ leg }) {
  const color = MODE_COLOR[leg.mode] || '#666';
  const icon = MODE_ICON[leg.mode] || '🚌';

  if (leg.mode === 'WALK') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 16px', color: '#555', fontSize: 12 }}>
        <span>🚶</span>
        <span>Walk {fmtDuration(leg.duration)}</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 16px', borderBottom: '1px solid #1a1d2a' }}>
      <div style={{
        minWidth: 44, height: 36, background: color, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: 12, color: 'white', flexShrink: 0,
        padding: '0 6px', gap: 3
      }}>
        {icon} {leg.routeShortName || leg.displayName || ''}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e8eaed', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {leg.from.name} → {leg.to.name}
        </div>
        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
          {fmt(leg.startTime)} – {fmt(leg.endTime)} · {fmtDuration(leg.duration)}
          {leg.headsign && <span style={{ color: '#444' }}> · dir. {leg.headsign}</span>}
          {leg.from.track && <span style={{ color: '#444' }}> · track {leg.from.track}</span>}
        </div>
        {leg.realTime && (
          <span style={{ fontSize: 10, color: '#4CAF50' }}>● live</span>
        )}
        {leg.cancelled && (
          <span style={{ fontSize: 10, color: '#FF5252' }}>⚠ cancelled</span>
        )}
      </div>
    </div>
  );
}

function ItineraryCard({ it, index }) {
  const [expanded, setExpanded] = useState(index === 0);
  const transitLegs = it.legs.filter(l => l.mode !== 'WALK');

  return (
    <div style={{ borderBottom: '2px solid #1e2130' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '12px 16px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: expanded ? '#1a1d2a' : 'transparent'
        }}
      >
        <div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            {it.legs.map((leg, i) => (
              <span key={i} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 2 }}>
                {i > 0 && <span style={{ color: '#333', fontSize: 10, margin: '0 1px' }}>›</span>}
                <span>{MODE_ICON[leg.mode] || '🚌'}</span>
                {leg.mode !== 'WALK' && (
                  <span style={{
                    fontSize: 11, fontWeight: 700,
                    background: MODE_COLOR[leg.mode] || '#666',
                    color: 'white', borderRadius: 4, padding: '1px 5px'
                  }}>
                    {leg.routeShortName || leg.displayName || leg.mode}
                  </span>
                )}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#666' }}>
            {fmt(it.startTime)} → {fmt(it.endTime)} · {fmtDuration(it.duration)}
            {it.transfers > 0 && ` · ${it.transfers} transfer${it.transfers !== 1 ? 's' : ''}`}
          </div>
        </div>
        <span style={{ color: '#444', fontSize: 14, flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ paddingBottom: 4 }}>
          {it.legs.map((leg, i) => <LegRow key={i} leg={leg} />)}
        </div>
      )}
    </div>
  );
}

export default function JourneyPlanner() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const search = async () => {
    if (!from.trim() || !to.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/journey?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#13151e' }}>
      {/* Search inputs */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e2130', background: '#0f1117' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14 }}>🟢</span>
            <input
              value={from}
              onChange={e => setFrom(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="From: e.g. Utrecht Centraal"
              style={{ ...inputStyle, paddingLeft: 32 }}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14 }}>🔴</span>
            <input
              value={to}
              onChange={e => setTo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="To: e.g. Rotterdam Centraal"
              style={{ ...inputStyle, paddingLeft: 32 }}
            />
          </div>
          <button onClick={search} disabled={loading} style={buttonStyle}>
            {loading ? 'Planning...' : '🔍 Plan journey'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{ padding: '16px', color: '#FF5252', fontSize: 13 }}>⚠️ {error}</div>
        )}
        {loading && (
          <div style={{ padding: 32, textAlign: 'center', color: '#555', fontSize: 13 }}>
            Finding best routes...
          </div>
        )}
        {result && !loading && (
          <>
            <div style={{ padding: '8px 16px', fontSize: 11, color: '#555', borderBottom: '1px solid #1e2130' }}>
              {result.from.name} → {result.to.name}
            </div>
            {result.itineraries.length === 0 && (
              <div style={{ padding: 32, textAlign: 'center', color: '#555', fontSize: 13 }}>
                No routes found between these locations.
              </div>
            )}
            {result.itineraries.map((it, i) => (
              <ItineraryCard key={i} it={it} index={i} />
            ))}
          </>
        )}
        {!result && !loading && !error && (
          <div style={{ padding: 32, textAlign: 'center', color: '#555', fontSize: 13 }}>
            Enter a start and destination to plan your journey across the Netherlands.
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  background: '#1e2130',
  border: '1px solid #2a2d3d',
  borderRadius: 8,
  padding: '8px 12px',
  color: '#e8eaed',
  fontSize: 13,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const buttonStyle = {
  background: '#4FC3F7',
  color: '#000',
  border: 'none',
  borderRadius: 8,
  padding: '9px 16px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  width: '100%',
};
