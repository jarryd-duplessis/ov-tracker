import { useEffect, useRef, useState, useCallback } from 'react';

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

export function useOVWebSocket() {
  const ws = useRef(null);
  const [departures, setDepartures] = useState([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);
  const reconnectTimer = useRef(null);
  const currentStops = useRef([]);

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      setConnected(true);
      setError(null);
      // Re-subscribe if we had stops
      if (currentStops.current.length > 0) {
        subscribe(currentStops.current);
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
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'subscribe', stopCodes }));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, [connect]);

  return { departures, connected, lastUpdate, error, subscribe };
}
