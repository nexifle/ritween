import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { miniButton } from "./controls";
import { Icon } from "./icon";
import { useRestHint } from "./rest-hint";
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
  const wellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const compDrag = useRef<{
    id: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const gesture = useRestHint("Scroll to zoom. Drag to pan.");
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
      if (!stage) return;
      setFrame({ width: stage.clientWidth, height: stage.clientHeight });
    });
    if (stage) {
      watch.observe(stage);
      setFrame({ width: stage.clientWidth, height: stage.clientHeight });
    }
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || frame.width <= 0) return;
    const next = clampCompPan(
      zoom,
      panX,
      panY,
      stage.clientWidth,
      stage.clientHeight,
    );
    if (next.panX !== panX || next.panY !== panY)
      onViewRef.current(zoom, next.panX, next.panY);
  }, [frame.width, frame.height, zoom, panX, panY]);
  useEffect(() => {
    const well = wellRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0016);
      zoomAtRef.current(event.clientX, event.clientY, factor);
    };
    well?.addEventListener("wheel", onWheel, { passive: false });
    return () => well?.removeEventListener("wheel", onWheel);
  }, []);

  const percent =
    frame.width > 0
      ? Math.max(1, Math.round(zoom * (frame.width / resolution[0]) * 100))
      : 100;
  const actualSizeZoom = frame.width > 0 ? resolution[0] / frame.width : 1;
  const zoomFromCenter = (factor: number) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    zoomAt(stage.left + stage.width / 2, stage.top + stage.height / 2, factor);
  };

  return (
    <section
      aria-label="Video preview"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {gesture.hint}
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
        ref={wellRef}
        className={`relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ containerType: "size" }}
        onPointerEnter={gesture.onPointerEnter}
        onPointerLeave={gesture.onPointerLeave}
        onPointerDown={(event) => {
          gesture.onPointerDown();
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
          gesture.onPointerMove(event);
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
          ref={stageRef}
          className="absolute top-1/2 left-1/2"
          style={{
            aspectRatio: `${aspectRatio[0]} / ${aspectRatio[1]}`,
            width: `min(100cqw, calc(100cqh * ${aspectRatio[0]} / ${aspectRatio[1]}))`,
            height: `min(100cqh, calc(100cqw * ${aspectRatio[1]} / ${aspectRatio[0]}))`,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div
            className="h-full w-full"
            style={{
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
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
      </div>
      <div className="px-2 pt-1.5 pb-2">{children}</div>
    </section>
  );
}
