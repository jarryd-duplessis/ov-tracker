import { useRef, useState, useCallback, useEffect } from 'react';

const PEEK = 96;      // px from bottom — shows handle + peek content
const SNAP_VELOCITY = 0.4; // px/ms threshold for velocity-based snap

export default function BottomSheet({ children, peekContent, onSnapChange }) {
  const sheetRef = useRef(null);
  const [snap, setSnap] = useState('half'); // 'peek' | 'half' | 'full'
  const dragRef = useRef({ active: false, startY: 0, startTop: 0, lastY: 0, lastT: 0, vy: 0 });

  // Compute snap positions based on window height
  const getSnapY = useCallback((s) => {
    const h = window.innerHeight;
    switch (s) {
      case 'peek': return h - PEEK;
      case 'half': return Math.round(h * 0.45);
      case 'full': return Math.round(h * 0.08);
      default: return Math.round(h * 0.45);
    }
  }, []);

  const snapTo = useCallback((s) => {
    setSnap(s);
    onSnapChange?.(s);
    const el = sheetRef.current;
    if (el) {
      el.style.transition = 'transform 0.35s cubic-bezier(0.25, 1, 0.5, 1)';
      el.style.transform = `translateY(${getSnapY(s)}px)`;
    }
  }, [getSnapY, onSnapChange]);

  // Set initial position
  useEffect(() => {
    const el = sheetRef.current;
    if (el) {
      el.style.transform = `translateY(${getSnapY('half')}px)`;
    }
  }, [getSnapY]);

  const onTouchStart = useCallback((e) => {
    const el = sheetRef.current;
    if (!el) return;
    // Only start drag from the handle area (top 44px of sheet)
    const rect = el.getBoundingClientRect();
    const touchY = e.touches[0].clientY;
    if (touchY - rect.top > 48) return; // finger is in content area, let it scroll
    el.style.transition = 'none';
    const current = new DOMMatrix(getComputedStyle(el).transform).m42 || getSnapY(snap);
    dragRef.current = {
      active: true,
      startY: touchY,
      startTop: current,
      lastY: touchY,
      lastT: Date.now(),
      vy: 0,
    };
  }, [snap, getSnapY]);

  const onTouchMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d.active) return;
    const touchY = e.touches[0].clientY;
    const now = Date.now();
    const dt = now - d.lastT;
    if (dt > 0) d.vy = (touchY - d.lastY) / dt;
    d.lastY = touchY;
    d.lastT = now;
    const newTop = d.startTop + (touchY - d.startY);
    // Clamp between full and just below screen
    const minY = getSnapY('full');
    const maxY = window.innerHeight - 40;
    const clamped = Math.max(minY, Math.min(maxY, newTop));
    sheetRef.current.style.transform = `translateY(${clamped}px)`;
  }, [getSnapY]);

  const onTouchEnd = useCallback(() => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    const el = sheetRef.current;
    const currentY = new DOMMatrix(getComputedStyle(el).transform).m42;
    const peekY = getSnapY('peek');
    const halfY = getSnapY('half');
    const fullY = getSnapY('full');

    // Velocity-based: if fast swipe, go in swipe direction
    if (Math.abs(d.vy) > SNAP_VELOCITY) {
      if (d.vy > 0) {
        // Swiping down
        snapTo(currentY < halfY ? 'half' : 'peek');
      } else {
        // Swiping up
        snapTo(currentY > halfY ? 'half' : 'full');
      }
      return;
    }

    // Position-based: snap to nearest
    const distances = [
      { snap: 'full', dist: Math.abs(currentY - fullY) },
      { snap: 'half', dist: Math.abs(currentY - halfY) },
      { snap: 'peek', dist: Math.abs(currentY - peekY) },
    ];
    distances.sort((a, b) => a.dist - b.dist);
    snapTo(distances[0].snap);
  }, [getSnapY, snapTo]);

  // Handle tap on peek to expand
  const handleHandleTap = useCallback(() => {
    if (snap === 'peek') snapTo('half');
    else if (snap === 'full') snapTo('half');
  }, [snap, snapTo]);

  return (
    <div
      ref={sheetRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{
        position: 'absolute',
        left: 0, right: 0,
        top: 0,
        height: '100%',
        background: 'var(--bg-card)',
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        boxShadow: '0 -4px 20px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        willChange: 'transform',
        zIndex: 20,
        touchAction: 'none',
      }}
    >
      {/* Handle */}
      <div
        onClick={handleHandleTap}
        style={{
          padding: '10px 16px 6px',
          cursor: 'grab',
          flexShrink: 0,
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <div style={{
          width: 36, height: 4,
          background: 'var(--border)',
          borderRadius: 2,
          margin: '0 auto 8px',
        }} />
        {/* Peek content — always visible */}
        {snap === 'peek' && peekContent}
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        overflow: snap === 'peek' ? 'hidden' : 'auto',
        display: snap === 'peek' ? 'none' : 'flex',
        flexDirection: 'column',
      }}>
        {children}
      </div>
    </div>
  );
}
