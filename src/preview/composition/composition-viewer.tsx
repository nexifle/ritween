import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { miniButton } from "../components/control-styles";
import { Icon } from "../components/icon";
import { useRestHint } from "../hooks/use-rest-hint";
import { clamp, clampCompPan, COMP_ZOOM_MAX, COMP_ZOOM_MIN } from "../utils/view-utils";

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
  sourceOpen,
  onToggleSource,
  source,
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
  sourceOpen: boolean;
  onToggleSource: () => void;
  source: ReactNode;
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
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-separator px-2.5 py-1 text-[11px]">
        {/* Left: View Identity & View Switcher */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 font-medium text-emphasis">
            <Icon name={sourceOpen ? "code" : "film"} size={14} />
            <span>{sourceOpen ? "Source" : "Composition"}</span>
          </div>

          <div className="h-3.5 w-px bg-separator/60" />

          {/* Segmented View Switcher: Picture | Code */}
          <div className="flex items-center rounded-sm bg-secondary/70 p-0.5 border border-control-border/30">
            <button
              type="button"
              className={`flex h-5 items-center gap-1 rounded-[2px] px-2 text-[11px] font-medium transition-colors ${
                sourceOpen
                  ? "text-control hover:text-foreground"
                  : "bg-accent text-accent-foreground shadow-xs"
              }`}
              aria-pressed={!sourceOpen}
              onClick={() => {
                if (sourceOpen) onToggleSource();
              }}
            >
              <Icon name="image" size={12} />
              <span>Picture</span>
            </button>
            <button
              type="button"
              className={`flex h-5 items-center gap-1 rounded-[2px] px-2 text-[11px] font-medium transition-colors ${
                sourceOpen
                  ? "bg-accent text-accent-foreground shadow-xs"
                  : "text-control hover:text-foreground"
              }`}
              aria-pressed={sourceOpen}
              onClick={() => {
                if (!sourceOpen) onToggleSource();
              }}
            >
              <Icon name="code" size={12} />
              <span>Code</span>
            </button>
          </div>
        </div>

        {/* Right: Resolution Info & Zoom Controls */}
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Resolution & Aspect Ratio Spec Badge */}
          <div className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-meta bg-card/60 px-2 py-0.5 rounded border border-separator/50">
            <span>
              {resolution[0]}×{resolution[1]}
            </span>
            <span className="mx-0.5 text-[10px] text-dot">·</span>
            <span>{aspectRatio.join(":")}</span>
          </div>

          {/* Canvas Zoom Controls (when picture is active) */}
          <div
            className={`items-center gap-1.5 ${sourceOpen ? "hidden" : "flex"}`}
          >
            <div className="h-3.5 w-px bg-separator/60" />

            {/* Stepper Cluster: [-] [ 20% ] [+] */}
            <div className="flex h-5 items-center rounded-sm border border-control-border/40 bg-secondary/70">
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded-l-[2px] text-control transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label="Zoom composition out"
                onClick={() => zoomFromCenter(1 / 1.2)}
                title="Zoom Out"
              >
                <Icon name="minus" size={11} strokeWidth={2} />
              </button>
              <span className="w-10 select-none px-0.5 text-center font-mono text-[11px] font-medium tabular-nums text-emphasis">
                {percent}%
              </span>
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded-r-[2px] text-control transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label="Zoom composition in"
                onClick={() => zoomFromCenter(1.2)}
                title="Zoom In"
              >
                <Icon name="plus" size={11} strokeWidth={2} />
              </button>
            </div>

            {/* Presets: Fit and 100% */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex h-5 items-center gap-1 rounded-[2px] border border-control-border/30 px-1.5 text-[11px] text-control transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label="Fit composition"
                onClick={() => setZoom(1)}
              >
                <Icon name="fit" size={11} />
                <span>Fit</span>
              </button>
              <button
                type="button"
                className="flex h-5 items-center rounded-[2px] border border-control-border/30 px-1.5 font-mono text-[11px] text-control transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label="Composition actual size"
                onClick={() => setZoom(actualSizeZoom)}
              >
                100%
              </button>
            </div>
          </div>
        </div>
      </div>
      {sourceOpen && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{source}</div>
      )}
      <div
        ref={wellRef}
        className={`${sourceOpen ? "hidden" : "relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas"} ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
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
                ? "Preview could not be prepared."
                : "Preparing picture and audio…"}
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-separator bg-card/25 px-2.5 py-1">
        {children}
      </div>
    </section>
  );
}
