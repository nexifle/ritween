import { usePersistentLayout } from "../hooks/use-persistent-layout";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { AudioTrack, SceneEntry } from "../../engine/types";
import { miniButton } from "../components/control-styles";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/resizable";
import { LaneBlock } from "./lane-block";
import { TrackHeader } from "./track-header";
import {
  clamp,
  clock,
  formatRulerTime,
  rulerMarks,
  TL_ZOOM_MIN,
  TL_ZOOM_MAX,
} from "../utils/view-utils";

const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"];

export type TimelineHandle = {
  reveal: (time: number) => void;
  zoomAroundTime: (factor: number, time: number) => void;
  fit: () => void;
};

export function Timeline({
  ref,
  duration,
  fps,
  time,
  playing,
  zoom,
  scenes,
  audioTracks,
  activeSceneId,
  mutedTrackIds,
  onZoom,
  onSeek,
  onToggleMute,
  savingSettings,
  onOpenSource,
}: {
  ref?: Ref<TimelineHandle>;
  duration: number;
  fps: number;
  time: number;
  playing: boolean;
  zoom: number;
  scenes: readonly SceneEntry[];
  audioTracks: readonly AudioTrack[];
  activeSceneId: string;
  mutedTrackIds: readonly string[];
  onZoom: (zoom: number) => void;
  onSeek: (time: number) => void;
  onToggleMute: (id: string) => void;
  savingSettings?: boolean;
  onOpenSource: (id: string) => void;
}) {
  const columns = usePersistentLayout("ritween-track-columns", [
    "track-names",
    "track-lanes",
  ]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const tlDrag = useRef<{ id: number; x: number; scroll: number } | null>(null);
  const scrubId = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  const [laneWidth, setLaneWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [laneScrollbar, setLaneScrollbar] = useState(0);
  zoomRef.current = zoom;

  const contentWidth =
    laneWidth > 0 ? Math.max(1, Math.round(laneWidth * zoom)) : 0;
  const pxPerSec = contentWidth > 0 ? contentWidth / duration : 0;
  const canvasWidth = Math.max(laneWidth, contentWidth);
  const canvasDuration = pxPerSec > 0 ? canvasWidth / pxPerSec : duration;

  const reveal = (nextTime: number) => {
    const el = scrollerRef.current;
    if (!el || laneWidth <= 0 || contentWidth <= 0) return;
    const x = (nextTime / duration) * contentWidth;
    const pad = 32;
    if (x < el.scrollLeft + pad || x > el.scrollLeft + laneWidth - pad) {
      el.scrollLeft = clamp(
        x - laneWidth * 0.35,
        0,
        Math.max(0, contentWidth - laneWidth),
      );
    }
  };
  const applyZoom = (nextZoom: number, anchorClientX: number | null) => {
    const el = scrollerRef.current;
    const clamped = clamp(nextZoom, TL_ZOOM_MIN, TL_ZOOM_MAX);
    if (el && el.clientWidth > 0) {
      const width = el.clientWidth;
      const currentWidth = Math.max(1, Math.round(width * zoomRef.current));
      const px = currentWidth / duration;
      const localX =
        anchorClientX == null
          ? width / 2
          : clamp(anchorClientX - el.getBoundingClientRect().left, 0, width);
      const anchorTime = (el.scrollLeft + localX) / px;
      const nextWidth = Math.max(1, Math.round(width * clamped));
      pendingScroll.current = clamp(
        anchorTime * (nextWidth / duration) - localX,
        0,
        Math.max(0, nextWidth - width),
      );
    }
    onZoom(clamped);
  };
  const zoomAroundTime = (factor: number, anchorTime: number) => {
    const el = scrollerRef.current;
    const anchor = el
      ? el.getBoundingClientRect().left +
        clamp(
          (anchorTime / duration) * contentWidth - el.scrollLeft,
          0,
          el.clientWidth,
        )
      : null;
    applyZoom(zoomRef.current * factor, anchor);
  };
  const fit = () => {
    pendingScroll.current = 0;
    onZoom(1);
  };

  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;
  const api = useRef({ reveal, zoomAroundTime, fit });
  api.current = { reveal, zoomAroundTime, fit };
  useImperativeHandle(
    ref,
    () => ({
      reveal: (nextTime) => api.current.reveal(nextTime),
      zoomAroundTime: (factor, anchorTime) =>
        api.current.zoomAroundTime(factor, anchorTime),
      fit: () => api.current.fit(),
    }),
    [],
  );

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || pendingScroll.current == null) return;
    el.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
    setScrollLeft(el.scrollLeft);
  }, [zoom, laneWidth]);
  const syncHeader = () => {
    const lane = scrollerRef.current;
    const header = headerRef.current;
    if (!lane || !header) return;
    const bar = lane.offsetHeight - lane.clientHeight;
    setLaneScrollbar((current) => (current === bar ? current : bar));
    header.scrollTop = lane.scrollTop;
  };
  useLayoutEffect(() => {
    const lane = scrollerRef.current;
    const header = headerRef.current;
    if (lane && header) header.scrollTop = lane.scrollTop;
  }, [laneScrollbar]);
  useEffect(() => {
    const lane = scrollerRef.current;
    const watch = new ResizeObserver(() => {
      if (!lane) return;
      setLaneWidth(lane.clientWidth);
      const bar = lane.offsetHeight - lane.clientHeight;
      setLaneScrollbar((current) => (current === bar ? current : bar));
    });
    if (lane) {
      watch.observe(lane);
      setLaneWidth(lane.clientWidth);
    }
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const lane = scrollerRef.current;
    const onWheel = (event: WheelEvent) => {
      if (!lane) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0016);
        applyZoomRef.current(zoomRef.current * factor, event.clientX);
        return;
      }
      const canScrollY = lane.scrollHeight > lane.clientHeight + 1;
      const horizontal =
        event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && (zoomRef.current <= 1.01 || canScrollY)) return;
      event.preventDefault();
      lane.scrollLeft += horizontal
        ? event.deltaX || event.deltaY
        : event.deltaY;
    };
    lane?.addEventListener("wheel", onWheel, { passive: false });
    return () => lane?.removeEventListener("wheel", onWheel);
  }, [laneWidth]);
  useEffect(() => {
    if (playing) api.current.reveal(time);
  }, [time, playing, laneWidth, zoom]);

  const viewStart = pxPerSec > 0 ? scrollLeft / pxPerSec : 0;
  const viewEnd = pxPerSec > 0 ? (scrollLeft + laneWidth) / pxPerSec : duration;
  const ruler = useMemo(
    () =>
      pxPerSec > 0
        ? rulerMarks(canvasDuration, pxPerSec, fps, viewStart, viewEnd)
        : { marks: [] as { time: number; major: boolean }[], major: 1 },
    [canvasDuration, pxPerSec, fps, viewStart, viewEnd],
  );
  const timeAtClient = (clientX: number) => {
    const content = contentRef.current;
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, Math.max(rect.width, 1));
    return clamp(pxPerSec > 0 ? x / pxPerSec : 0, 0, duration);
  };

  return (
    <section
      aria-label="Read-only composition timeline"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-sequence"
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-separator px-2 py-1">
        <div className="flex items-center gap-2">
          <h2 className="text-xs/normal font-medium">Timeline</h2>
          {savingSettings && (
            <span role="status" className="text-[10px] text-meta">
              Saving…
            </span>
          )}
          <span className="text-[11px] text-meta">
            V1 · {audioTracks.length} audio
          </span>
          <span className="font-mono text-[11px] tabular-nums text-emphasis">
            {clock(time)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 hidden text-[11px] text-faint sm:inline">
            Read-only
          </span>
          <button
            type="button"
            className={miniButton}
            aria-label="Zoom timeline out"
            onClick={() => applyZoom(zoom / 1.25, null)}
          >
            −
          </button>
          <input
            aria-label="Timeline zoom"
            type="range"
            min={0}
            max={1000}
            value={Math.round(
              (Math.log(zoom / TL_ZOOM_MIN) /
                Math.log(TL_ZOOM_MAX / TL_ZOOM_MIN)) *
                1000,
            )}
            onChange={(event) =>
              applyZoom(
                TL_ZOOM_MIN *
                  Math.pow(
                    TL_ZOOM_MAX / TL_ZOOM_MIN,
                    Number(event.target.value) / 1000,
                  ),
                null,
              )
            }
            className="w-[88px] accent-primary"
          />
          <button
            type="button"
            className={miniButton}
            aria-label="Zoom timeline in"
            onClick={() => applyZoom(zoom * 1.25, null)}
          >
            +
          </button>
          <span className="w-10 text-center font-mono text-[10px] tabular-nums text-meta">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className={miniButton}
            aria-label="Fit timeline"
            onClick={fit}
          >
            Fit
          </button>
        </div>
      </div>
      <ResizablePanelGroup
        id="ritween-track-columns"
        defaultLayout={columns.defaultLayout}
        onLayoutChanged={columns.onLayoutChanged}
        orientation="horizontal"
        className="min-h-0 min-w-0 flex-1"
      >
        <ResizablePanel
          id="track-names"
          defaultSize="180px"
          minSize="90px"
          maxSize="40%"
          style={{ overflow: "hidden" }}
        >
          <div className="flex h-full min-h-0 flex-col bg-secondary">
            <div className="flex h-9 shrink-0 items-center border-b border-row px-2 text-[10px] text-meta">
              Layers
            </div>
            <div
              ref={headerRef}
              className="min-h-0 flex-1 overflow-hidden"
              onWheel={(event) => {
                if (scrollerRef.current)
                  scrollerRef.current.scrollTop += event.deltaY;
              }}
            >
              <TrackHeader
                label="Scenes"
                detail={`V1 · ${scenes.length} clips`}
              />
              {audioTracks.map((track, index) => (
                <TrackHeader
                  key={track.id}
                  label={track.name}
                  detail={`A${index + 1} · ${track.clips.length} clips`}
                  muted={mutedTrackIds.includes(track.id)}
                  muteDisabled={savingSettings}
                  onMute={() => onToggleMute(track.id)}
                />
              ))}
              <div style={{ height: laneScrollbar }} />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize layer names" />
        <ResizablePanel
          id="track-lanes"
          minSize="50%"
          style={{ overflow: "hidden" }}
        >
          <div
            ref={scrollerRef}
            className="h-full min-h-0 min-w-0 overflow-auto"
            onScroll={(event) => {
              setScrollLeft(event.currentTarget.scrollLeft);
              syncHeader();
            }}
          >
            <div
              ref={contentRef}
              className="relative min-h-full select-none"
              style={{ width: canvasWidth > 0 ? canvasWidth : "100%" }}
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest("button")) return;
                if (event.button === 1 || event.altKey) {
                  event.preventDefault();
                  const scroller = scrollerRef.current;
                  if (!scroller) return;
                  tlDrag.current = {
                    id: event.pointerId,
                    x: event.clientX,
                    scroll: scroller.scrollLeft,
                  };
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    /* Capture is only available for a real active pointer. */
                  }
                  return;
                }
                if (event.button !== 0) return;
                scrubId.current = event.pointerId;
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  /* Capture is only available for a real active pointer. */
                }
                onSeek(timeAtClient(event.clientX));
              }}
              onPointerMove={(event) => {
                if (tlDrag.current?.id === event.pointerId) {
                  const scroller = scrollerRef.current;
                  if (!scroller) return;
                  scroller.scrollLeft =
                    tlDrag.current.scroll - (event.clientX - tlDrag.current.x);
                  return;
                }
                if (scrubId.current === event.pointerId)
                  onSeek(timeAtClient(event.clientX));
              }}
              onPointerUp={(event) => {
                if (tlDrag.current?.id === event.pointerId)
                  tlDrag.current = null;
                if (scrubId.current === event.pointerId) scrubId.current = null;
              }}
              onPointerCancel={() => {
                tlDrag.current = null;
                scrubId.current = null;
              }}
            >
              <div
                data-timeline-ruler
                className="sticky top-0 z-10 h-9 overflow-hidden border-b border-row bg-muted"
              >
                {canvasDuration > duration && (
                  <div
                    data-timeline-ruler-after-end
                    className="pointer-events-none absolute inset-y-0 right-0 border-l border-separator bg-sequence/50"
                    style={{ left: contentWidth }}
                    aria-label={`Project ends at ${clock(duration)}`}
                  />
                )}
                {ruler.marks.map((mark, index) => {
                  const left = mark.time * pxPerSec;
                  const room = canvasWidth - left;
                  const label = formatRulerTime(mark.time, ruler.major, fps);
                  return (
                    <div
                      key={`${index}-${mark.time}`}
                      className="absolute bottom-0"
                      style={{ left, opacity: mark.time > duration ? 0.4 : 1 }}
                    >
                      <div
                        className={`w-px ${mark.major ? "h-[13px] bg-faint" : "h-[6px] bg-tick"}`}
                      />
                      {mark.major && room >= 64 && (
                        <span className="absolute bottom-4 left-1 whitespace-nowrap font-mono text-[11px] leading-3 text-meta">
                          {label}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div
                  className="pointer-events-none absolute bottom-0 top-0 w-px bg-playhead"
                  style={{ left: time * pxPerSec }}
                >
                  <div
                    className="absolute left-1/2 top-0 h-2.5 w-[11px] -translate-x-1/2 bg-playhead"
                    style={{
                      clipPath:
                        "polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)",
                    }}
                  />
                </div>
              </div>
              {canvasDuration > duration && (
                <div
                  data-timeline-after-end
                  className="pointer-events-none absolute bottom-0 top-9 right-0 border-l border-dashed border-separator bg-muted/25"
                  style={{ left: contentWidth }}
                />
              )}
              <div className="pointer-events-none absolute bottom-0 top-9 left-0 right-0">
                {ruler.marks
                  .filter((mark) => mark.major)
                  .map((mark) => (
                    <div
                      key={`grid-${mark.time}`}
                      className="absolute bottom-0 top-0 w-px bg-row"
                      style={{
                        left: mark.time * pxPerSec,
                        opacity: mark.time > duration ? 0.35 : 1,
                      }}
                    />
                  ))}
              </div>
              <div className="relative h-16 border-b border-row">
                {scenes.map((scene, index) => (
                  <LaneBlock
                    key={scene.id}
                    start={scene.start}
                    duration={scene.duration}
                    total={canvasDuration}
                    color={colors[index % colors.length]}
                    title={scene.name}
                    detail={scene.source}
                    timing={`${clock(scene.start)} – ${clock(scene.start + scene.duration)}`}
                    active={activeSceneId === scene.id}
                    onInspect={() => onOpenSource(scene.id)}
                  />
                ))}
              </div>
              {audioTracks.map((track, index) => (
                <div
                  key={track.id}
                  className={`relative h-16 border-b border-row ${mutedTrackIds.includes(track.id) ? "opacity-45" : ""}`}
                >
                  {track.clips.map((clip) => (
                    <LaneBlock
                      key={clip.id}
                      start={clip.start}
                      duration={clip.duration}
                      total={canvasDuration}
                      color={colors[(index + 1) % colors.length]}
                      title={clip.name}
                      detail={`${clip.duration.toFixed(2)}s`}
                      timing={`${clock(clip.start)} – ${clock(clip.start + clip.duration)}`}
                    />
                  ))}
                </div>
              ))}
              <div
                className="pointer-events-none absolute bottom-0 top-9 z-[2] w-px bg-playhead"
                style={{ left: time * pxPerSec }}
              ></div>
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}
