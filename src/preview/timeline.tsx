import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import type { AudioTrack, SceneEntry } from "../engine/types";
import { miniButton } from "./controls";
import { LaneBlock } from "./lane-block";
import { TrackHeader } from "./track-header";
import {
  clamp,
  clock,
  formatRulerTime,
  rulerMarks,
  TL_ZOOM_MAX,
} from "./view";

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
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const tlDrag = useRef<{ id: number; x: number; scroll: number } | null>(null);
  const scrubId = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  const [laneWidth, setLaneWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  zoomRef.current = zoom;

  const contentWidth =
    laneWidth > 0 ? Math.max(1, Math.round(laneWidth * zoom)) : 0;
  const pxPerSec = contentWidth > 0 ? contentWidth / duration : 0;

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
    const clamped = clamp(nextZoom, 1, TL_ZOOM_MAX);
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
  useImperativeHandle(ref, () => ({
    reveal: (nextTime) => api.current.reveal(nextTime),
    zoomAroundTime: (factor, anchorTime) =>
      api.current.zoomAroundTime(factor, anchorTime),
    fit: () => api.current.fit(),
  }), []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || pendingScroll.current == null) return;
    el.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
    setScrollLeft(el.scrollLeft);
  }, [zoom, laneWidth]);
  useEffect(() => {
    const lane = scrollerRef.current;
    const watch = new ResizeObserver(() => {
      if (lane) setLaneWidth(lane.clientWidth);
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
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && zoomRef.current <= 1.01) return;
      event.preventDefault();
      lane.scrollLeft += horizontal ? event.deltaX : event.deltaY;
    };
    lane?.addEventListener("wheel", onWheel, { passive: false });
    return () => lane?.removeEventListener("wheel", onWheel);
  }, [laneWidth]);
  useEffect(() => {
    if (playing) api.current.reveal(time);
  }, [time, playing, laneWidth, zoom]);

  const viewStart = pxPerSec > 0 ? scrollLeft / pxPerSec : 0;
  const viewEnd = pxPerSec > 0 ? (scrollLeft + laneWidth) / pxPerSec : duration;
  const ruler =
    pxPerSec > 0
      ? rulerMarks(duration, pxPerSec, fps, viewStart, viewEnd)
      : { marks: [] as { time: number; major: boolean }[], major: 1 };
  const timeAtClient = (clientX: number) => {
    const content = contentRef.current;
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, Math.max(rect.width, 1));
    return (x / Math.max(rect.width, 1)) * duration;
  };

  return (
    <section
      aria-label="Read-only composition timeline"
      className="mt-3 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-separator px-2 py-1">
        <div className="flex items-center gap-2">
          <h2 className="text-xs/normal font-medium">Timeline</h2>
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
            value={Math.round((Math.log(zoom) / Math.log(TL_ZOOM_MAX)) * 1000)}
            onChange={(event) =>
              applyZoom(Math.pow(TL_ZOOM_MAX, Number(event.target.value) / 1000), null)
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
      <div className="flex min-w-0">
        <div className="w-[92px] shrink-0 border-r border-separator bg-secondary">
          <div className="h-7 border-b border-row" />
          <TrackHeader label="V1" />
          {audioTracks.map((track) => (
            <TrackHeader
              key={track.id}
              label={track.name}
              muted={mutedTrackIds.includes(track.id)}
              onMute={() => onToggleMute(track.id)}
            />
          ))}
        </div>
        <div
          ref={scrollerRef}
          title="Scroll to pan. Command or Ctrl-scroll to zoom. Drag to scrub. Alt-drag to pan."
          className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
          <div
            ref={contentRef}
            className="relative select-none"
            style={{ width: contentWidth > 0 ? contentWidth : "100%" }}
            onPointerDown={(event) => {
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
              if (tlDrag.current?.id === event.pointerId) tlDrag.current = null;
              if (scrubId.current === event.pointerId) scrubId.current = null;
            }}
            onPointerCancel={() => {
              tlDrag.current = null;
              scrubId.current = null;
            }}
          >
            <div className="relative h-7 overflow-hidden border-b border-row bg-muted">
              {ruler.marks.map((mark, index) => {
                const left = `${(mark.time / duration) * 100}%`;
                const room = contentWidth - (mark.time / duration) * contentWidth;
                const label = formatRulerTime(mark.time, ruler.major, fps);
                return (
                  <div
                    key={`${index}-${mark.time}`}
                    className="absolute bottom-0"
                    style={{ left }}
                  >
                    <div
                      className={`w-px ${mark.major ? "h-[9px] bg-faint" : "h-[5px] bg-tick"}`}
                    />
                    {mark.major && room >= 64 && (
                      <span className="absolute bottom-2.5 left-1 whitespace-nowrap font-mono text-[11px] leading-3 text-meta">
                        {label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="pointer-events-none absolute bottom-0 top-7 left-0 right-0">
              {ruler.marks
                .filter((mark) => mark.major)
                .map((mark) => (
                  <div
                    key={`grid-${mark.time}`}
                    className="absolute bottom-0 top-0 w-px bg-row"
                    style={{ left: `${(mark.time / duration) * 100}%` }}
                  />
                ))}
            </div>
            <div className="relative h-[34px] border-b border-row">
              {scenes.map((scene, index) => (
                <LaneBlock
                  key={scene.id}
                  start={scene.start}
                  duration={scene.duration}
                  total={duration}
                  color={colors[index % colors.length]}
                  title={scene.name}
                  detail={scene.source}
                  active={activeSceneId === scene.id}
                />
              ))}
            </div>
            {audioTracks.map((track, index) => (
              <div
                key={track.id}
                className={`relative h-[34px] border-b border-row ${mutedTrackIds.includes(track.id) ? "opacity-45" : ""}`}
              >
                {track.clips.map((clip) => (
                  <LaneBlock
                    key={clip.id}
                    start={clip.start}
                    duration={clip.duration}
                    total={duration}
                    color={colors[(index + 1) % colors.length]}
                    title={clip.name}
                    detail={`${clip.duration}s`}
                  />
                ))}
              </div>
            ))}
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-[2] w-px bg-playhead"
              style={{ left: `${(time / duration) * 100}%` }}
            >
              <div
                className="absolute left-1/2 top-0 h-2 w-[9px] -translate-x-1/2 bg-playhead"
                style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
