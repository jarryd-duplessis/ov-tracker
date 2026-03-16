import { useEffect, useRef, useState, useCallback } from 'react';

// In development the Vite proxy handles /ws → localhost:3001.
// In production set VITE_WS_URL=wss://ws.ov.jarryd.co.za at build time.
const WS_URL = import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

export function useOVWebSocket() {
  const ws = useRef(null);
  const [departures, setDepartures] = useState([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);
  const reconnectTimer = useRef(null);
  const subscribeTimer = useRef(null);
  const currentStops = useRef([]);

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      setConnected(true);
      setError(null);
      // Re-subscribe immediately on reconnect (no debounce needed — this is a fresh connection)
      if (currentStops.current.length > 0) {
        ws.current.send(JSON.stringify({ type: 'subscribe', stopCodes: currentStops.current }));
      }
    };

    ws.current.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'departures') {
          setDepartures(msg.departures);
          setLastUpdate(new Date(msg.fetchedAt));
        }
        if (msg.type === 'error') {
          setError(msg.message);
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    ws.current.onclose = () => {
      setConnected(false);
      // Reconnect after 3 seconds
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.current.onerror = () => {
      setError('Connection error — retrying...');
    };
  }, []);

  const subscribe = useCallback((stopCodes) => {
    currentStops.current = stopCodes;
    // Debounce: GPS updates and map moves fire rapidly. Collapse multiple
    // subscribe calls within 800ms into one to avoid thrashing poll groups.
    clearTimeout(subscribeTimer.current);
    subscribeTimer.current = setTimeout(() => {
      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'subscribe', stopCodes: currentStops.current }));
      }
    }, 800);
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearTimeout(subscribeTimer.current);
      ws.current?.close();
    };
  }, [connect]);

  return { departures, connected, lastUpdate, error, subscribe };
}
