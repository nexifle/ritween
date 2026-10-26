import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { miniButton } from "./controls";
import { Icon } from "./icon";
import { clamp, clampCompPan, COMP_ZOOM_MAX, COMP_ZOOM_MIN } from "./view";

export function CompositionViewer({
  resolution,
  aspectRatio,
  zoom,
  panX,
  panY,
  ready,
  error,
  canvasRef,
  onView,
  children,
}: {
  resolution: readonly [number, number];
  aspectRatio: readonly [number, number];
  zoom: number;
  panX: number;
  panY: number;
  ready: boolean;
  error: string;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onView: (zoom: number, panX: number, panY: number) => void;
  children: ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const compDrag = useRef<{
    id: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef({ zoom, panX, panY });
  const onViewRef = useRef(onView);
  const zoomAtRef = useRef<
    (clientX: number, clientY: number, factor: number) => void
  >(() => {});
  viewRef.current = { zoom, panX, panY };
  onViewRef.current = onView;

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const current = viewRef.current;
    const nextZoom = clamp(current.zoom * factor, COMP_ZOOM_MIN, COMP_ZOOM_MAX);
    const ox = clientX - rect.left - rect.width / 2;
    const oy = clientY - rect.top - rect.height / 2;
    const ratio = nextZoom / current.zoom;
    const next = clampCompPan(
      nextZoom,
      ox - (ox - current.panX) * ratio,
      oy - (oy - current.panY) * ratio,
      rect.width,
      rect.height,
    );
    onView(nextZoom, next.panX, next.panY);
  };
  const setZoom = (nextZoom: number) => {
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    const clamped = clamp(nextZoom, COMP_ZOOM_MIN, COMP_ZOOM_MAX);
    const next = rect
      ? clampCompPan(clamped, 0, 0, rect.width, rect.height)
      : { panX: 0, panY: 0 };
    onView(clamped, next.panX, next.panY);
  };
  zoomAtRef.current = zoomAt;

  useEffect(() => {
    const stage = stageRef.current;
    const watch = new ResizeObserver(() => {
      if (stage) setStageWidth(stage.clientWidth);
    });
    if (stage) {
      watch.observe(stage);
      setStageWidth(stage.clientWidth);
    }
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || stageWidth <= 0) return;
    const next = clampCompPan(
      zoom,
      panX,
      panY,
      stage.clientWidth,
      stage.clientHeight,
    );
    if (next.panX !== panX || next.panY !== panY)
      onViewRef.current(zoom, next.panX, next.panY);
  }, [stageWidth, zoom, panX, panY]);
  useEffect(() => {
    const stage = stageRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0016);
      zoomAtRef.current(event.clientX, event.clientY, factor);
    };
    stage?.addEventListener("wheel", onWheel, { passive: false });
    return () => stage?.removeEventListener("wheel", onWheel);
  }, [stageWidth]);

  const percent =
    stageWidth > 0
      ? Math.max(1, Math.round(zoom * (stageWidth / resolution[0]) * 100))
      : 100;
  const actualSizeZoom = stageWidth > 0 ? resolution[0] / stageWidth : 1;
  const zoomFromCenter = (factor: number) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    zoomAt(stage.left + stage.width / 2, stage.top + stage.height / 2, factor);
  };

  return (
    <section
      aria-label="Video preview"
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-separator px-2 py-1 text-[11px]">
        <span className="flex items-center gap-1.5 text-emphasis">
          <Icon name="film" size={14} />
          Composition
        </span>
        <span className="text-meta">
          {resolution[0]}×{resolution[1]}
          <span className="mx-1.5 text-dot">·</span>
          {aspectRatio.join(":")}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={miniButton}
            aria-label="Zoom composition out"
            onClick={() => zoomFromCenter(1 / 1.2)}
          >
            −
          </button>
          <span className="w-[46px] text-center font-mono text-[11px] tabular-nums text-emphasis">
            {percent}%
          </span>
          <button
            type="button"
            className={miniButton}
            aria-label="Zoom composition in"
            onClick={() => zoomFromCenter(1.2)}
          >
            +
          </button>
          <button
            type="button"
            className={miniButton}
            aria-label="Fit composition"
            onClick={() => setZoom(1)}
          >
            Fit
          </button>
          <button
            type="button"
            className={miniButton}
            aria-label="Composition actual size"
            onClick={() => setZoom(actualSizeZoom)}
          >
            100%
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        title="Scroll to zoom. Drag to pan."
        className={`relative touch-none overflow-hidden bg-canvas ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ aspectRatio: aspectRatio[0] / aspectRatio[1] }}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.button !== 1) return;
          event.preventDefault();
          compDrag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            panX,
            panY,
          };
          setDragging(true);
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* Capture is only available for a real active pointer. */
          }
        }}
        onPointerMove={(event) => {
          const drag = compDrag.current;
          const stage = stageRef.current;
          if (!drag || drag.id !== event.pointerId || !stage) return;
          const rect = stage.getBoundingClientRect();
          const next = clampCompPan(
            zoom,
            drag.panX + event.clientX - drag.x,
            drag.panY + event.clientY - drag.y,
            rect.width,
            rect.height,
          );
          onView(zoom, next.panX, next.panY);
        }}
        onPointerUp={(event) => {
          if (compDrag.current?.id === event.pointerId) compDrag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          compDrag.current = null;
          setDragging(false);
        }}
      >
        <div
          className="absolute left-1/2 top-1/2 h-full w-full"
          style={{
            transform: `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${zoom})`,
          }}
        >
          <canvas
            ref={canvasRef}
            width={resolution[0]}
            height={resolution[1]}
            className="block h-full w-full ring-1 ring-stage"
            aria-label="WebGPU composition preview"
          />
        </div>
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-overlay/90 p-4 text-center text-[13px] text-overlay-foreground">
            {error
              ? "Preview requires an available WebGPU device."
              : "Preparing scene pipelines…"}
          </div>
        )}
      </div>
      <div className="px-2 pt-1.5 pb-2">{children}</div>
    </section>
  );
}
