import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

const restDelay = 700;

export function useRestHint(label: string) {
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  const shown = useRef(false);
  const point = useRef({ x: 0, y: 0 });

  const clearTimer = () => {
    if (timer.current == null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    clearTimer();
    if (!shown.current) return;
    shown.current = false;
    setHint(null);
  };
  const rest = (event: ReactPointerEvent) => {
    point.current = { x: event.clientX, y: event.clientY };
    clearTimer();
    if (shown.current) {
      shown.current = false;
      setHint(null);
    }
    timer.current = window.setTimeout(() => {
      shown.current = true;
      setHint(point.current);
    }, restDelay);
  };
  useEffect(() => hide, []);

  const node =
    hint &&
    createPortal(
      <div
        role="tooltip"
        className="pointer-events-none fixed z-40 max-w-64 rounded-sm border border-border bg-popover px-2 py-1 text-[11px] leading-[1.4] text-popover-foreground"
        style={{
          left: Math.min(hint.x + 12, window.innerWidth - 268),
          top: Math.min(hint.y + 16, window.innerHeight - 40),
        }}
      >
        {label}
      </div>,
      document.body,
    );

  return {
    onPointerEnter: rest,
    onPointerMove: rest,
    onPointerLeave: hide,
    onPointerDown: hide,
    hint: node,
  };
}
