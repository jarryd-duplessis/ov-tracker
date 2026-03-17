import { useState, useEffect, useRef, useCallback } from 'react';

function PlaceInput({ value, onChange, placeholder, icon }) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => { setQuery(value); }, [value]);

  const fetchSuggestions = useCallback((q) => {
    clearTimeout(debounceRef.current);
    if (q.trim().length < 2) { setSuggestions([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q, format: 'json', limit: 5, countrycodes: 'nl',
          addressdetails: 1, 'accept-language': 'nl',
        });
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
          headers: { 'Accept-Language': 'nl' },
        });
        const data = await res.json();
        setSuggestions(data);
        setOpen(data.length > 0);
        setActive(-1);
      } catch (e) { console.warn('Nominatim error:', e); }
    }, 280);
  }, []);

  const pick = (s) => {
    const label = s.display_name.split(',').slice(0, 2).join(',').trim();
    setQuery(label);
    onChange(label);
    setSuggestions([]);
    setOpen(false);
  };

  const handleKey = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(suggestions[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  useEffect(() => {
    const handler = (e) => { if (!containerRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1 }}>
      <div style={{
        position: 'relative',
        display: 'flex', alignItems: 'center',
      }}>
        <span style={{
          position: 'absolute', left: 12, fontSize: 8,
          width: 10, height: 10, borderRadius: '50%',
          background: icon === 'from' ? 'var(--green)' : 'var(--red)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1, pointerEvents: 'none',
        }} />
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); onChange(e.target.value); fetchSuggestions(e.target.value); }}
          onKeyDown={handleKey}
          onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
          placeholder={placeholder}
          autoComplete="off"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 12px 10px 30px',
            color: 'var(--text)',
            outline: 'none',
            width: '100%',
            boxSizing: 'border-box',
            transition: 'border-color 0.15s',
          }}
        />
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          marginTop: 4, overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
          animation: 'fadeIn 0.15s ease',
        }}>
          {suggestions.map((s, i) => {
            const parts = s.display_name.split(',');
            const main = parts.slice(0, 2).join(',').trim();
            const sub = parts.slice(2, 4).join(',').trim();
            return (
              <div
                key={s.place_id}
                onMouseDown={() => pick(s)}
                onMouseEnter={() => setActive(i)}
                style={{
                  padding: '10px 14px', cursor: 'pointer', fontSize: 13,
                  background: i === active ? 'var(--bg-hover)' : 'transparent',
                  borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none',
                }}
              >
                <div style={{ color: 'var(--text)', fontWeight: 500 }}>{main}</div>
                {sub && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>{sub}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MODE_ICON = {
  WALK: '🚶', BUS: '🚌', TRAM: '🚊', SUBWAY: '🚇', METRO: '🚇',
  RAIL: '🚆', REGIONAL_FAST_RAIL: '🚆', REGIONAL_RAIL: '🚆',
  LONG_DISTANCE: '🚄', HIGHSPEED_RAIL: '🚄', FERRY: '⛴️', BICYCLE: '🚲',
};

const MODE_COLOR = {
  WALK: '#888', BUS: '#4CAF50', TRAM: '#FF9800', SUBWAY: '#2196F3', METRO: '#2196F3',
  RAIL: '#9C27B0', REGIONAL_FAST_RAIL: '#9C27B0', REGIONAL_RAIL: '#9C27B0',
  LONG_DISTANCE: '#E91E63', HIGHSPEED_RAIL: '#E91E63', FERRY: '#00BCD4',
};

function fmt(isoStr) {
  return new Date(isoStr).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(seconds) {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function walkDistance(leg) {
  if (leg.distance) return leg.distance;
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(leg.to.lat - leg.from.lat);
  const dLon = toRad(leg.to.lon - leg.from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(leg.from.lat)) * Math.cos(toRad(leg.to.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function StopTimeline({ leg }) {
  const color = MODE_COLOR[leg.mode] || '#666';
  const stops = [
    { name: leg.from.name, time: leg.startTime, track: leg.from.track, cancelled: leg.from.cancelled },
    ...(leg.intermediateStops || []).map(s => ({
      name: s.name, time: s.departure || s.arrival, track: s.track, cancelled: s.cancelled,
    })),
    { name: leg.to.name, time: leg.endTime, track: leg.to.track, cancelled: leg.to.cancelled },
  ];

  return (
    <div style={{ margin: '6px 0 4px 0' }}>
      {stops.map((stop, i) => {
        const isFirst = i === 0;
        const isLast = i === stops.length - 1;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16, flexShrink: 0 }}>
              <div style={{ width: 2, flex: isFirst ? '0 0 6px' : '1 1 0', background: isFirst ? 'transparent' : color, opacity: 0.5 }} />
              <div style={{
                width: isFirst || isLast ? 8 : 5,
                height: isFirst || isLast ? 8 : 5,
                borderRadius: '50%',
                background: isFirst || isLast ? color : 'var(--bg-card)',
                border: `2px solid ${color}`, flexShrink: 0,
              }} />
              <div style={{ width: 2, flex: isLast ? '0 0 6px' : '1 1 0', background: isLast ? 'transparent' : color, opacity: 0.5 }} />
            </div>
            <div style={{ paddingLeft: 8, paddingTop: 1, paddingBottom: isLast ? 0 : 5, flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 4 }}>
                <span style={{
                  fontSize: isFirst || isLast ? 12 : 11,
                  fontWeight: isFirst || isLast ? 600 : 400,
                  color: stop.cancelled ? 'var(--red)' : isFirst || isLast ? 'var(--text)' : 'var(--text-secondary)',
                  textDecoration: stop.cancelled ? 'line-through' : 'none',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {stop.name}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {stop.time ? fmt(stop.time) : ''}
                  {stop.track && <span style={{ marginLeft: 4 }}>P{stop.track}</span>}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LegRow({ leg }) {
  const color = MODE_COLOR[leg.mode] || '#666';
  const icon = MODE_ICON[leg.mode] || '🚌';
  const [showStops, setShowStops] = useState(false);
  const stopCount = (leg.intermediateStops || []).length;

  if (leg.mode === 'WALK') {
    const dist = walkDistance(leg);
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px',
        color: 'var(--text-secondary)', fontSize: 12,
        borderLeft: '2px dashed var(--border)',
        marginLeft: 18,
      }}>
        <span>🚶</span>
        <div>
          <span style={{ fontWeight: 500 }}>Walk {fmtDuration(leg.duration)}</span>
          <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>· {fmtDistance(dist)}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 10, padding: '10px 14px' }}>
        <div style={{
          minWidth: 42, height: 30, background: color,
          borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: 11, color: 'white', flexShrink: 0,
          padding: '0 6px', gap: 3, boxShadow: 'var(--shadow-sm)',
        }}>
          {icon} {leg.routeShortName || leg.displayName || ''}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: 'var(--text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {leg.from.name} → {leg.to.name}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)', marginTop: 2,
            fontVariantNumeric: 'tabular-nums',
            display: 'flex', flexWrap: 'wrap', gap: '0 6px',
          }}>
            <span>{fmt(leg.startTime)} – {fmt(leg.endTime)}</span>
            <span style={{ color: 'var(--text-muted)' }}>· {fmtDuration(leg.duration)}</span>
            {leg.headsign && <span style={{ color: 'var(--text-muted)' }}>· {leg.headsign}</span>}
            {leg.from.track && <span style={{ color: 'var(--text-muted)' }}>· P{leg.from.track}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
            {leg.realTime && (
              <span style={{
                fontSize: 10, color: 'var(--green)', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: 3,
              }}>
                <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--green)' }} />
                live
              </span>
            )}
            {leg.cancelled && <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 600 }}>cancelled</span>}
            {stopCount > 0 && (
              <button onClick={() => setShowStops(s => !s)} style={{
                background: 'none', border: 'none', color: 'var(--accent)',
                cursor: 'pointer', fontSize: 11, padding: 0, fontWeight: 500,
              }}>
                {showStops ? 'Hide' : `${stopCount + 2} stops`}
              </button>
            )}
          </div>
        </div>
      </div>
      {showStops && (
        <div style={{ padding: '0 14px 8px 14px', animation: 'fadeIn 0.15s ease' }}>
          <StopTimeline leg={leg} />
        </div>
      )}
    </div>
  );
}

function ItineraryCard({ it, isSelected, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  const lastLeg = it.legs[it.legs.length - 1];
  const finalWalk = lastLeg?.mode === 'WALK' ? lastLeg : null;
  const finalWalkDist = finalWalk ? walkDistance(finalWalk) : 0;
  const lastTransitLeg = [...it.legs].reverse().find(l => l.mode !== 'WALK');

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
      background: isSelected ? 'var(--accent-bg)' : 'transparent',
      transition: 'background 0.15s',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '12px 14px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Mode chain */}
          <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            {it.legs.filter(l => l.mode !== 'WALK').map((leg, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10, margin: '0 1px' }}>›</span>}
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  background: MODE_COLOR[leg.mode] || '#666',
                  color: 'white',
                  borderRadius: 4,
                  padding: '1px 5px',
                }}>
                  {MODE_ICON[leg.mode] || ''} {leg.routeShortName || leg.displayName || leg.mode}
                </span>
              </span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {fmt(it.startTime)} → {fmt(it.endTime)} · {fmtDuration(it.duration)}
            {it.transfers > 0 && ` · ${it.transfers}x`}
          </div>
          {finalWalk && finalWalkDist > 30 && (
            <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 3 }}>
              🚶 {fmtDistance(finalWalkDist)} to destination
            </div>
          )}
        </div>

        {/* Arrival time — prominent */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {fmt(it.endTime)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, letterSpacing: '0.3px' }}>
            arrive
          </div>
        </div>
      </div>

      {/* Expand toggle */}
      {expanded && (
        <div style={{ animation: 'fadeIn 0.15s ease' }}>
          {it.legs.map((leg, i) => <LegRow key={i} leg={leg} />)}
        </div>
      )}

      {/* Actions row */}
      <div style={{
        display: 'flex', gap: 8, padding: '0 14px 10px',
        alignItems: 'center',
      }}>
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(it); }}
          style={{
            flex: 1, padding: '8px 14px',
            borderRadius: 'var(--radius-md)',
            border: isSelected ? '1px solid var(--accent-border)' : 'none',
            background: isSelected ? 'var(--accent-bg)' : 'var(--accent)',
            color: isSelected ? 'var(--accent)' : '#000',
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
            boxShadow: isSelected ? 'none' : 'var(--shadow-sm)',
          }}
        >
          {isSelected ? '✓ Planned' : 'Show on map'}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          style={{
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 11, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {expanded ? 'Less' : 'Details'}
        </button>
      </div>
    </div>
  );
}

function TimePicker({ time, setTime, arriveBy, setArriveBy }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <select
        value={arriveBy ? 'arrive' : 'depart'}
        onChange={e => setArriveBy(e.target.value === 'arrive')}
        style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: '8px 10px', color: 'var(--text)',
          outline: 'none', cursor: 'pointer',
        }}
      >
        <option value="depart">Depart</option>
        <option value="arrive">Arrive</option>
      </select>
      <input
        type="time"
        value={time}
        onChange={e => setTime(e.target.value)}
        style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: '8px 10px', color: 'var(--text)',
          outline: 'none', flex: 1,
        }}
      />
      <button
        onClick={() => {
          const now = new Date();
          setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
        }}
        style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: '8px 10px', color: 'var(--text-secondary)',
          fontSize: 12, cursor: 'pointer', fontWeight: 600,
        }}
      >
        Now
      </button>
    </div>
  );
}

export default function JourneyPlanner({ onSelectJourney, userLocation }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fromCoords, setFromCoords] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [arriveBy, setArriveBy] = useState(false);
  const now = new Date();
  const [time, setTime] = useState(
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  );

  const handleFromChange = useCallback((val) => {
    setFrom(val);
    setFromCoords(null);
  }, []);

  const useMyLocation = useCallback(() => {
    if (!userLocation) return;
    setFrom('My location');
    setFromCoords({ lat: userLocation.lat, lon: userLocation.lon });
  }, [userLocation]);

  // Swap from/to
  const handleSwap = useCallback(() => {
    setFrom(prev => {
      setTo(from);
      return to;
    });
    setFromCoords(null);
  }, [from, to]);

  const search = async () => {
    if ((!from.trim() && !fromCoords) || !to.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedKey(null);
    try {
      const [h, m] = time.split(':');
      const dt = new Date();
      dt.setHours(parseInt(h), parseInt(m), 0, 0);
      const params = new URLSearchParams({ to, time: dt.toISOString() });
      if (fromCoords) {
        params.set('fromLat', fromCoords.lat);
        params.set('fromLon', fromCoords.lon);
        params.set('from', 'My location');
      } else {
        params.set('from', from);
      }
      if (arriveBy) params.set('arriveBy', 'true');
      const res = await fetch(`/api/journey?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const canSearch = (from.trim() || fromCoords) && to.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-card)' }}>
      {/* Search form */}
      <div style={{
        padding: '12px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* From row */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <PlaceInput value={from} onChange={handleFromChange} placeholder="From" icon="from" />
            {userLocation && (
              <button
                onClick={useMyLocation}
                title="Use my location"
                style={{
                  background: fromCoords ? 'var(--accent)' : 'var(--bg-surface)',
                  border: `1px solid ${fromCoords ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-md)',
                  width: 40, height: 40,
                  color: fromCoords ? '#000' : 'var(--text-secondary)',
                  fontSize: 14, cursor: 'pointer', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                📍
              </button>
            )}
          </div>

          {/* Swap button */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={handleSwap}
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-full)',
                width: 28, height: 28,
                cursor: 'pointer', fontSize: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-secondary)',
                margin: '-4px 0',
                zIndex: 1,
              }}
              title="Swap from and to"
            >
              ⇅
            </button>
          </div>

          {/* To row */}
          <PlaceInput value={to} onChange={setTo} placeholder="To" icon="to" />

          <TimePicker time={time} setTime={setTime} arriveBy={arriveBy} setArriveBy={setArriveBy} />

          <button
            onClick={search}
            disabled={loading || !canSearch}
            style={{
              background: !canSearch ? 'var(--bg-surface)' : 'var(--accent)',
              color: !canSearch ? 'var(--text-muted)' : '#000',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              padding: '10px 16px',
              fontSize: 13, fontWeight: 700,
              cursor: !canSearch ? 'default' : 'pointer',
              width: '100%',
              boxShadow: canSearch && !loading ? 'var(--shadow-sm)' : 'none',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{
            padding: 14, margin: 14,
            background: 'var(--red-bg)', borderRadius: 'var(--radius-md)',
            color: 'var(--red)', fontSize: 12,
          }}>
            {error}
          </div>
        )}
        {loading && (
          <div style={{
            padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              width: 20, height: 20, border: '2.5px solid var(--border)',
              borderTopColor: 'var(--accent)', borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }} />
            Finding routes...
          </div>
        )}
        {result && !loading && (
          <>
            <div style={{
              padding: '8px 14px', fontSize: 11, color: 'var(--text-secondary)',
              borderBottom: '1px solid var(--border)', fontWeight: 500,
            }}>
              {result.from.name} → {result.to.name} · {result.itineraries.length} option{result.itineraries.length !== 1 ? 's' : ''}
            </div>
            {result.itineraries.length === 0 && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No routes found.
              </div>
            )}
            {result.itineraries.map((it, i) => {
              const key = `${it.startTime}-${it.endTime}`;
              return (
                <ItineraryCard
                  key={key} it={it}
                  isSelected={selectedKey === key}
                  onSelect={(it) => { setSelectedKey(key); onSelectJourney?.(it); }}
                />
              );
            })}
          </>
        )}
        {!result && !loading && !error && (
          <div style={{
            padding: 48, textAlign: 'center',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <span style={{ fontSize: 28, opacity: 0.3 }}>🗺</span>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Plan your journey
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, opacity: 0.7 }}>
              Any address, station, or place in the Netherlands
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
