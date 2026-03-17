import { useEffect, useRef, useState, useCallback } from 'react';

const POLL_INTERVAL = 15000;

// Replaces the WebSocket push model (which caused a Lambda→SQS recursive loop)
// with direct HTTP polling of /api/departures. Same interface, no backend loop.
export function useOVWebSocket() {
  const [departures, setDepartures] = useState([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);

  const currentStops = useRef([]);
  const intervalRef = useRef(null);
  const debounceRef = useRef(null);

  const fetchDepartures = useCallback(async () => {
    const stops = currentStops.current;
    if (stops.length === 0) return;
    // Only pass KV7 stop codes (8+ digits) — openov-nl IDs return 404 from OVapi
    const kv7 = stops.filter(s => s.length >= 8);
    if (kv7.length === 0) { setDepartures([]); return; }
    try {
      const res = await fetch(`/api/departures?stops=${kv7.join(',')}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDepartures(data.departures || []);
      setLastUpdate(new Date(data.fetchedAt));
      setConnected(true);
      setError(null);
    } catch (e) {
      setConnected(false);
      setError('Could not fetch departures — retrying...');
    }
  }, []);

  const subscribe = useCallback((stopCodes, { immediate = false } = {}) => {
    currentStops.current = stopCodes;
    clearTimeout(debounceRef.current);
    clearInterval(intervalRef.current);
    if (immediate) {
      // User explicitly selected a stop — clear stale departures and fetch now
      setDepartures([]);
      fetchDepartures();
      intervalRef.current = setInterval(fetchDepartures, POLL_INTERVAL);
    } else {
      // Debounce rapid calls (GPS updates, map pans)
      debounceRef.current = setTimeout(() => {
        clearInterval(intervalRef.current);
        fetchDepartures();
        intervalRef.current = setInterval(fetchDepartures, POLL_INTERVAL);
      }, 800);
    }
  }, [fetchDepartures]);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      clearInterval(intervalRef.current);
    };
  }, []);

  return { departures, connected, lastUpdate, error, subscribe };
}
