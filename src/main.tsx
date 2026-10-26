import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Renderer } from "./engine/renderer";
import { PREVIEW_VOLUME_DB, PreviewAudio } from "./engine/audio";
import { exportVideo } from "./engine/export";
import { evaluate, frameCount } from "./engine/timeline";
import { project } from "virtual:rimotion-project";
import "./style.css";

type State = {
  time: number;
  playing: boolean;
  ready: boolean;
  error: string;
  exporting: boolean;
  done: number;
  total: number;
  resolution: string;
  fps: number;
  result: string;
  download: string;
  mutedTrackIds: string[];
  volumeDb: number;
  masterMuted: boolean;
  compZoom: number;
  compPanX: number;
  compPanY: number;
  tlZoom: number;
};
const initial: State = {
  time: 0,
  playing: false,
  ready: false,
  error: "",
  exporting: false,
  done: 0,
  total: frameCount(project.duration, 30),
  resolution: "1280x720",
  fps: 30,
  result: "",
  download: "",
  mutedTrackIds: [],
  volumeDb: PREVIEW_VOLUME_DB,
  masterMuted: false,
  compZoom: 1,
  compPanX: 0,
  compPanY: 0,
  tlZoom: 1,
};
type Action =
  | { type: "patch"; value: Partial<State> }
  | { type: "seek"; time: number }
  | { type: "tick"; delta: number }
  | { type: "sync"; time: number }
  | { type: "toggle" }
  | { type: "pause" }
  | { type: "toggleTrackMute"; id: string }
  | { type: "toggleMasterMute" }
  | { type: "setVolume"; volumeDb: number }
  | { type: "compView"; zoom: number; panX: number; panY: number }
  | { type: "tlZoom"; zoom: number };
function reducer(s: State, a: Action): State {
  if (a.type === "patch") return { ...s, ...a.value };
  if (a.type === "pause") return { ...s, playing: false };
  if (a.type === "toggle")
    return {
      ...s,
      playing: !s.playing,
      time: s.time >= project.duration ? 0 : s.time,
    };
  if (a.type === "toggleMasterMute")
    return { ...s, masterMuted: !s.masterMuted };
  if (a.type === "setVolume")
    return { ...s, volumeDb: Math.max(-60, Math.min(0, a.volumeDb)) };
  if (a.type === "compView")
    return {
      ...s,
      compZoom: clamp(a.zoom, COMP_ZOOM_MIN, COMP_ZOOM_MAX),
      compPanX: a.panX,
      compPanY: a.panY,
    };
  if (a.type === "tlZoom")
    return { ...s, tlZoom: clamp(a.zoom, 1, TL_ZOOM_MAX) };
  if (a.type === "toggleTrackMute")
    return {
      ...s,
      mutedTrackIds: s.mutedTrackIds.includes(a.id)
        ? s.mutedTrackIds.filter((id) => id !== a.id)
        : [...s.mutedTrackIds, a.id],
    };
  if (a.type === "seek" || a.type === "sync") {
    const time = Math.max(0, Math.min(project.duration, a.time));
    return {
      ...s,
      time,
      playing: a.type === "sync" ? time < project.duration : s.playing,
    };
  }
  const time = Math.min(project.duration, s.time + a.delta);
  return { ...s, time, playing: time < project.duration };
}
const COMP_ZOOM_MIN = 0.25;
const COMP_ZOOM_MAX = 32;
const TL_ZOOM_MAX = 80;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const clock = (time: number) =>
  `${Math.floor(time / 60)
    .toString()
    .padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;
function rulerStep(pxPerSec: number, fps: number) {
  const frame = 1 / fps;
  const raw = 78 / Math.max(pxPerSec, 0.0001);
  const frames = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const step = frames.find((count) => count * frame >= raw - 1e-9);
  return (step ?? frames[frames.length - 1]) * frame;
}
function formatRulerTime(time: number, step: number, fps: number) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const safe = Math.max(0, time);
  if (step < 0.5 - 1e-6) {
    const frames = Math.round(safe * fps);
    const ff = ((frames % fps) + fps) % fps;
    const total = Math.floor(frames / fps);
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}:${pad(ff)}`;
  }
  const whole = Math.floor(safe);
  const mm = Math.floor(whole / 60);
  const ss = whole % 60;
  if (step < 1 - 1e-6) return `${mm}:${pad(ss)}.${Math.round((safe - whole) * 10)}`;
  return `${mm}:${pad(ss)}`;
}
function rulerMarks(
  duration: number,
  pxPerSec: number,
  fps: number,
  viewStart: number,
  viewEnd: number,
) {
  const major = rulerStep(pxPerSec, fps);
  const minorDiv = major * pxPerSec >= 150 ? 5 : major * pxPerSec >= 96 ? 2 : 1;
  const minor = major / minorDiv;
  const first = Math.max(0, Math.floor((viewStart - major) / minor));
  const last = Math.ceil((viewEnd + major) / minor);
  const marks: { time: number; major: boolean }[] = [];
  for (let index = first; index <= last; index++) {
    const time = index * minor;
    if (time < -1e-6 || time > duration + 1e-4) continue;
    const snapped = Math.min(duration, Math.max(0, time));
    marks.push({
      time: snapped,
      major: Math.abs(snapped / major - Math.round(snapped / major)) < 1e-3,
    });
  }
  return { marks, major };
}
function clampCompPan(
  zoom: number,
  panX: number,
  panY: number,
  width: number,
  height: number,
) {
  const maxX = Math.max(0, (width * zoom - width) / 2);
  const maxY = Math.max(0, (height * zoom - height) / 2);
  return { panX: clamp(panX, -maxX, maxX), panY: clamp(panY, -maxY, maxY) };
}
const miniButton =
  "flex h-[22px] min-w-[22px] items-center justify-center rounded-[3px] px-[5px] text-[11px] leading-none text-[#c5c8d4] hover:bg-[#30323c] hover:text-white";
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    play: <path d="m8 5 11 7-11 7Z" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    restart: (
      <>
        <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />
      </>
    ),
    back: (
      <>
        <path d="M6 5v14m12-14L8 12l10 7Z" />
      </>
    ),
    next: (
      <>
        <path d="M18 5v14M6 5l10 7-10 7Z" />
      </>
    ),
    export: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
      </>
    ),
    code: (
      <>
        <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    film: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 4v16M17 4v16M3 9h4m-4 6h4M17 9h4m-4 6h4" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function TrackHeader({
  label,
  muted,
  onMute,
}: {
  label: string;
  muted?: boolean;
  onMute?: () => void;
}) {
  return (
    <div className={`flex h-[34px] items-center justify-between gap-[4px] border-b border-[#2a2d36] px-[6px] ${muted ? "opacity-45" : ""}`}>
      <span className="min-w-0 truncate text-[11px] font-medium text-[#c5c8d6]">
        {label}
      </span>
      {onMute && (
        <button
          type="button"
          aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
          aria-pressed={muted}
          onClick={onMute}
          className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[3px] border text-[11px] font-semibold leading-none ${muted ? "border-[#baa5ff] bg-[#2a2438] text-[#e4d8ff]" : "border-[#3a3d49] text-[#9aa0b2]"}`}
        >
          M
        </button>
      )}
    </div>
  );
}
function LaneBlock({
  start,
  duration,
  total,
  color,
  title,
  detail,
  active,
}: {
  start: number;
  duration: number;
  total: number;
  color: string;
  title: string;
  detail: string;
  active?: boolean;
}) {
  return (
    <div
      className="absolute top-[3px] bottom-[3px] overflow-hidden rounded-[3px] border px-[6px]"
      style={{
        left: `${(start / total) * 100}%`,
        width: `${(duration / total) * 100}%`,
        borderColor: active ? color : "#373b4a",
        backgroundColor: `${color}12`,
      }}
    >
      <div className="truncate text-[11px] font-medium leading-[12px]" style={{ color }}>
        {title}
      </div>
      <p className="truncate font-mono text-[11px] leading-[12px] text-[#9aa3b5]">{detail}</p>
    </div>
  );
}
const control =
  "flex h-[28px] w-[28px] items-center justify-center rounded-[4px] text-[#b8bac6] hover:bg-[#30323c] hover:text-white disabled:opacity-40";
function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const abort = useRef<AbortController | null>(null);
  const resultUrl = useRef("");
  const alive = useRef(true);
  const audio = useRef<PreviewAudio | null>(null);
  const timeRef = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const compDrag = useRef<{
    id: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const tlDrag = useRef<{ id: number; x: number; scroll: number } | null>(null);
  const scrubId = useRef<number | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [laneWidth, setLaneWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [compDragging, setCompDragging] = useState(false);
  const compRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  const tlZoomRef = useRef(1);
  const zoomCompAtRef = useRef<
    (clientX: number, clientY: number, factor: number) => void
  >(() => {});
  const applyTlZoomRef = useRef<
    (nextZoom: number, anchorClientX: number | null) => void
  >(() => {});
  compRef.current = {
    zoom: state.compZoom,
    panX: state.compPanX,
    panY: state.compPanY,
  };
  tlZoomRef.current = state.tlZoom;
  const patch = (value: Partial<State>) => dispatch({ type: "patch", value });
  const mix = () => {
    if (!audio.current) audio.current = new PreviewAudio();
    return audio.current;
  };
  timeRef.current = state.time;
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const initialization = new AbortController();
    void Renderer.create(
      canvas.current!,
      project,
      (error) => {
        if (!cancelled) patch({ error, playing: false, ready: false });
      },
      initialization.signal,
    )
      .then((r) => {
        if (cancelled) {
          r.dispose();
          return;
        }
        renderer.current = r;
        r.render(0);
        patch({ ready: true });
      })
      .catch((e) => {
        if (!cancelled)
          patch({ error: String(e instanceof Error ? e.message : e) });
      });
    return () => {
      alive.current = false;
      cancelled = true;
      initialization.abort();
      abort.current?.abort();
      renderer.current?.dispose();
      renderer.current = null;
      audio.current?.dispose();
      audio.current = null;
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
    };
  }, []);
  useEffect(() => {
    if (!state.ready) return;
    try {
      renderer.current?.render(state.time);
    } catch (e) {
      patch({ error: String(e), playing: false, ready: false });
    }
  }, [state.time, state.ready]);
  const mutedKey = state.mutedTrackIds.join("\0");
  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    player.setMonitor(state.volumeDb, state.masterMuted);
  }, [state.volumeDb, state.masterMuted]);
  useEffect(() => {
    if (!state.playing) {
      audio.current?.stop();
      return;
    }
    const player = mix();
    player.setMonitor(state.volumeDb, state.masterMuted);
    let cancelled = false;
    void player
      .play(timeRef.current, project, state.mutedTrackIds)
      .catch((e) => {
        if (!cancelled)
          patch({
            error: e instanceof Error ? e.message : String(e),
            playing: false,
          });
      });
    let id = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const heard = player.heardTime();
      if (heard == null) dispatch({ type: "tick", delta: (now - last) / 1000 });
      else dispatch({ type: "sync", time: heard });
      last = now;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      player.stop();
    };
  }, [state.playing, mutedKey]);
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) dispatch({ type: "pause" });
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  const toggle = () => {
    if (!state.ready) return;
    mix().unlock();
    dispatch({ type: "toggle" });
  };
  const seekTo = (time: number) => {
    dispatch({ type: "seek", time });
    if (state.playing)
      audio.current?.seek(Math.max(0, Math.min(project.duration, time)));
  };
  const contentWidth =
    laneWidth > 0 ? Math.max(1, Math.round(laneWidth * state.tlZoom)) : 0;
  const pxPerSec = contentWidth > 0 ? contentWidth / project.duration : 0;
  const revealTime = (time: number) => {
    const el = scrollerRef.current;
    if (!el || laneWidth <= 0 || contentWidth <= 0) return;
    const x = (time / project.duration) * contentWidth;
    const pad = 32;
    if (x < el.scrollLeft + pad || x > el.scrollLeft + laneWidth - pad) {
      el.scrollLeft = clamp(
        x - laneWidth * 0.35,
        0,
        Math.max(0, contentWidth - laneWidth),
      );
    }
  };
  const applyTlZoom = (nextZoom: number, anchorClientX: number | null) => {
    const el = scrollerRef.current;
    const zoom = clamp(nextZoom, 1, TL_ZOOM_MAX);
    if (el && el.clientWidth > 0) {
      const width = el.clientWidth;
      const currentWidth = Math.max(1, Math.round(width * tlZoomRef.current));
      const px = currentWidth / project.duration;
      const localX =
        anchorClientX == null
          ? width / 2
          : clamp(anchorClientX - el.getBoundingClientRect().left, 0, width);
      const time = (el.scrollLeft + localX) / px;
      const nextWidth = Math.max(1, Math.round(width * zoom));
      pendingScroll.current = clamp(
        time * (nextWidth / project.duration) - localX,
        0,
        Math.max(0, nextWidth - width),
      );
    }
    dispatch({ type: "tlZoom", zoom });
  };
  const zoomCompAt = (clientX: number, clientY: number, factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const current = compRef.current;
    const zoom = clamp(current.zoom * factor, COMP_ZOOM_MIN, COMP_ZOOM_MAX);
    const ox = clientX - rect.left - rect.width / 2;
    const oy = clientY - rect.top - rect.height / 2;
    const ratio = zoom / current.zoom;
    const next = clampCompPan(
      zoom,
      ox - (ox - current.panX) * ratio,
      oy - (oy - current.panY) * ratio,
      rect.width,
      rect.height,
    );
    dispatch({ type: "compView", zoom, panX: next.panX, panY: next.panY });
  };
  zoomCompAtRef.current = zoomCompAt;
  applyTlZoomRef.current = applyTlZoom;
  const setCompZoom = (zoom: number) => {
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    const next = rect
      ? clampCompPan(zoom, 0, 0, rect.width, rect.height)
      : { panX: 0, panY: 0 };
    dispatch({
      type: "compView",
      zoom: clamp(zoom, COMP_ZOOM_MIN, COMP_ZOOM_MAX),
      panX: next.panX,
      panY: next.panY,
    });
  };
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || pendingScroll.current == null) return;
    el.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
    setScrollLeft(el.scrollLeft);
  }, [state.tlZoom, laneWidth]);
  useEffect(() => {
    const stage = stageRef.current;
    const lane = scrollerRef.current;
    const watch = new ResizeObserver(() => {
      if (stage) setStageWidth(stage.clientWidth);
      if (lane) setLaneWidth(lane.clientWidth);
    });
    if (stage) {
      watch.observe(stage);
      setStageWidth(stage.clientWidth);
    }
    if (lane) {
      watch.observe(lane);
      setLaneWidth(lane.clientWidth);
    }
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || stageWidth <= 0) return;
    const next = clampCompPan(
      state.compZoom,
      state.compPanX,
      state.compPanY,
      stage.clientWidth,
      stage.clientHeight,
    );
    if (next.panX !== state.compPanX || next.panY !== state.compPanY)
      dispatch({
        type: "compView",
        zoom: state.compZoom,
        panX: next.panX,
        panY: next.panY,
      });
  }, [stageWidth, state.compZoom, state.compPanX, state.compPanY]);
  useEffect(() => {
    const stage = stageRef.current;
    const lane = scrollerRef.current;
    const onCompWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0016);
      zoomCompAtRef.current(event.clientX, event.clientY, factor);
    };
    const onLaneWheel = (event: WheelEvent) => {
      if (!lane) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0016);
        applyTlZoomRef.current(tlZoomRef.current * factor, event.clientX);
        return;
      }
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && tlZoomRef.current <= 1.01) return;
      event.preventDefault();
      lane.scrollLeft += horizontal ? event.deltaX : event.deltaY;
    };
    stage?.addEventListener("wheel", onCompWheel, { passive: false });
    lane?.addEventListener("wheel", onLaneWheel, { passive: false });
    return () => {
      stage?.removeEventListener("wheel", onCompWheel);
      lane?.removeEventListener("wheel", onLaneWheel);
    };
  }, [stageWidth, laneWidth]);
  useEffect(() => {
    if (state.playing) revealTime(state.time);
  }, [state.time, state.playing, laneWidth, state.tlZoom]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        ["INPUT", "SELECT", "BUTTON", "A"].includes(
          (e.target as HTMLElement).tagName,
        )
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      }
      if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
        e.preventDefault();
        const time = state.time + (e.code === "ArrowRight" ? 1 : -1) / state.fps;
        seekTo(time);
        revealTime(time);
      }
      if (e.key === "-" || e.key === "_" || e.key === "=" || e.key === "+") {
        e.preventDefault();
        const el = scrollerRef.current;
        const zoomingIn = e.key === "=" || e.key === "+";
        const anchor = el
          ? el.getBoundingClientRect().left +
            clamp(
              (state.time / project.duration) * contentWidth - el.scrollLeft,
              0,
              el.clientWidth,
            )
          : null;
        applyTlZoom(tlZoomRef.current * (zoomingIn ? 1.25 : 0.8), anchor);
      }
      if (e.key === "\\") {
        e.preventDefault();
        pendingScroll.current = 0;
        dispatch({ type: "tlZoom", zoom: 1 });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [state.time, state.playing, state.ready, state.fps, contentWidth]);
  async function startExport() {
    const controller = new AbortController();
    abort.current = controller;
    patch({
      exporting: true,
      done: 0,
      total: frameCount(project.duration, state.fps),
      error: "",
      result: "",
    });
    const [width, height] = state.resolution.split("x").map(Number);
    try {
      const result = await exportVideo(project, {
        width,
        height,
        fps: state.fps,
        mutedTrackIds: state.mutedTrackIds,
        signal: controller.signal,
        onProgress: (done, total) => {
          if (alive.current) patch({ done, total });
        },
      });
      if (!alive.current) return;
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
      const url = URL.createObjectURL(result.blob);
      resultUrl.current = url;
      patch({
        result: `${result.frames} frames · ${result.duration.toFixed(2)} seconds · ${(result.blob.size / 1048576).toFixed(1)} MB`,
        download: url,
      });
      const a = document.createElement("a");
      a.href = url;
      a.download = "source-to-motion.mp4";
      a.click();
    } catch (e) {
      if (alive.current) {
        if (controller.signal.aborted) patch({ result: "Export cancelled." });
        else patch({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (alive.current) patch({ exporting: false });
      abort.current = null;
    }
  }
  const active = evaluate(project, state.time).entry;
  const colors = ["#b8a1f5", "#78cfde", "#d1a6ca"];
  const compPercent =
    stageWidth > 0
      ? Math.max(
          1,
          Math.round(
            state.compZoom * (stageWidth / project.resolution[0]) * 100,
          ),
        )
      : 100;
  const viewStart = pxPerSec > 0 ? scrollLeft / pxPerSec : 0;
  const viewEnd =
    pxPerSec > 0 ? (scrollLeft + laneWidth) / pxPerSec : project.duration;
  const ruler =
    pxPerSec > 0
      ? rulerMarks(project.duration, pxPerSec, state.fps, viewStart, viewEnd)
      : { marks: [] as { time: number; major: boolean }[], major: 1 };
  const timeAtClient = (clientX: number) => {
    const content = contentRef.current;
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, Math.max(rect.width, 1));
    return (x / Math.max(rect.width, 1)) * project.duration;
  };
  const actualSizeZoom =
    stageWidth > 0 ? project.resolution[0] / stageWidth : 1;
  return (
    <div className="min-h-screen bg-[#131418] text-[#ececf2]">
      <header className="flex min-h-[48px] flex-wrap items-center justify-between gap-[12px] border-b border-[#2b2d35] px-[16px]">
        <a
          href="/"
          className="flex items-center gap-[11px] text-[21px] font-semibold tracking-[-0.6px]"
        >
          <span className="flex h-[29px] w-[29px] items-center justify-center rounded-[8px] bg-[#baa5ff] text-[#181323]">
            <Icon name="film" size={19} />
          </span>
          rimotion
          <span className="ml-[3px] rounded-[4px] border border-[#3b354c] px-[6px] py-[2px] text-[11px] font-medium tracking-[0px] text-[#c1afd8]">
            dev preview
          </span>
        </a>
        <div className="flex items-center gap-[22px] text-[12px] text-[#a8abb9]">
          <span className="hidden sm:inline">
            Code authored. Frame perfect.
          </span>
          <a
            href="https://github.com/gpuweb/gpuweb"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-[7px] hover:text-white"
          >
            <Icon name="code" size={15} /> WebGPU runtime
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-[12px] py-[12px]">
        <div className="mb-[10px] flex flex-wrap items-end justify-between gap-[8px]">
          <div>
            <div className="mb-[2px] flex items-center gap-[6px] text-[11px] text-[#989cab]">
              <span>Projects</span>
              <span className="text-[#535765]">/</span>
              <span className="text-[#d6d7e0]">Demo composition</span>
            </div>
            <h1 className="text-[20px] font-medium leading-[1.15] tracking-[-0.4px]">
              {project.name}
            </h1>
          </div>
          <div className="flex items-center gap-[6px] rounded-[4px] border border-[#31333d] bg-[#1b1d23] px-[8px] py-[4px] text-[11px] text-[#b7bac8]">
            <span
              className={`h-[6px] w-[6px] rounded-full ${state.ready ? "bg-[#86cbb5]" : "bg-[#d6b47d]"}`}
            />
            {state.ready
              ? "Runtime connected"
              : state.error
                ? "Runtime unavailable"
                : "Initializing WebGPU"}
          </div>
        </div>
        {state.error && (
          <div
            role="alert"
            className="mb-[20px] rounded-[8px] border border-[#784451] bg-[#35232a] px-[18px] py-[14px] text-[13px] text-[#ffd1db]"
          >
            <strong className="block">Rendering or export error</strong>
            <p className="mt-[4px] whitespace-pre-wrap">{state.error}</p>
          </div>
        )}
        <div className="grid items-start gap-[12px] lg:grid-cols-[minmax(0,1fr)_268px]">
          <section
            aria-label="Video preview"
            className="min-w-0 overflow-hidden rounded-[8px] border border-[#30323c] bg-[#1b1d23]"
          >
            <div className="flex min-h-[32px] flex-wrap items-center justify-between gap-x-[8px] gap-y-[4px] border-b border-[#2c2f38] px-[8px] py-[4px] text-[11px]">
              <span className="flex items-center gap-[6px] text-[#d5d8e4]">
                <Icon name="film" size={14} />
                Composition
              </span>
              <span className="text-[#9aa0b2]">
                {project.resolution[0]}×{project.resolution[1]}
                <span className="mx-[6px] text-[#4e5260]">·</span>
                {project.aspectRatio.join(":")}
              </span>
              <div className="flex items-center gap-[2px]">
                <button
                  type="button"
                  className={miniButton}
                  aria-label="Zoom composition out"
                  onClick={() => {
                    const stage = stageRef.current?.getBoundingClientRect();
                    if (!stage) return;
                    zoomCompAt(
                      stage.left + stage.width / 2,
                      stage.top + stage.height / 2,
                      1 / 1.2,
                    );
                  }}
                >
                  −
                </button>
                <span className="w-[46px] text-center font-mono text-[11px] tabular-nums text-[#d5d8e4]">
                  {compPercent}%
                </span>
                <button
                  type="button"
                  className={miniButton}
                  aria-label="Zoom composition in"
                  onClick={() => {
                    const stage = stageRef.current?.getBoundingClientRect();
                    if (!stage) return;
                    zoomCompAt(
                      stage.left + stage.width / 2,
                      stage.top + stage.height / 2,
                      1.2,
                    );
                  }}
                >
                  +
                </button>
                <button
                  type="button"
                  className={miniButton}
                  aria-label="Fit composition"
                  onClick={() => setCompZoom(1)}
                >
                  Fit
                </button>
                <button
                  type="button"
                  className={miniButton}
                  aria-label="Composition actual size"
                  onClick={() => setCompZoom(actualSizeZoom)}
                >
                  100%
                </button>
              </div>
            </div>
            <div
              ref={stageRef}
              title="Scroll to zoom. Drag to pan."
              className={`relative touch-none overflow-hidden bg-[#101114] ${compDragging ? "cursor-grabbing" : "cursor-grab"}`}
              style={{
                aspectRatio: project.aspectRatio[0] / project.aspectRatio[1],
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 && event.button !== 1) return;
                event.preventDefault();
                compDrag.current = {
                  id: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  panX: state.compPanX,
                  panY: state.compPanY,
                };
                setCompDragging(true);
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
                  state.compZoom,
                  drag.panX + event.clientX - drag.x,
                  drag.panY + event.clientY - drag.y,
                  rect.width,
                  rect.height,
                );
                dispatch({
                  type: "compView",
                  zoom: state.compZoom,
                  panX: next.panX,
                  panY: next.panY,
                });
              }}
              onPointerUp={(event) => {
                if (compDrag.current?.id === event.pointerId)
                  compDrag.current = null;
                setCompDragging(false);
              }}
              onPointerCancel={() => {
                compDrag.current = null;
                setCompDragging(false);
              }}
            >
              <div
                className="absolute left-1/2 top-1/2 h-full w-full"
                style={{
                  transform: `translate(calc(-50% + ${state.compPanX}px), calc(-50% + ${state.compPanY}px)) scale(${state.compZoom})`,
                }}
              >
                <canvas
                  ref={canvas}
                  width={project.resolution[0]}
                  height={project.resolution[1]}
                  className="block h-full w-full shadow-[0_0_0_1px_#3a3d4a]"
                  aria-label="WebGPU composition preview"
                />
              </div>
              {!state.ready && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0d1323]/90 p-[16px] text-center text-[13px] text-[#bac1d6]">
                  {state.error
                    ? "Preview requires an available WebGPU device."
                    : "Preparing scene pipelines…"}
                </div>
              )}
            </div>
            <div className="px-[8px] pb-[8px] pt-[6px]">
              <input
                aria-label="Playback scrubber"
                type="range"
                min={0}
                max={project.duration}
                step={1 / state.fps}
                value={state.time}
                onChange={(e) => {
                  const time = Number(e.target.value);
                  seekTo(time);
                  revealTime(time);
                }}
                className="w-full accent-[#baa5ff]"
              />
              <div className="mt-[4px] flex flex-wrap items-center justify-between gap-[6px]">
                <div className="flex items-center gap-[4px]">
                  <button
                    className={control}
                    disabled={!state.ready}
                    onClick={() => {
                      seekTo(0);
                      revealTime(0);
                    }}
                    aria-label="Restart"
                  >
                    <Icon name="restart" size={16} />
                  </button>
                  <button
                    className={control}
                    disabled={!state.ready}
                    onClick={() => {
                      const time = state.time - 1 / state.fps;
                      seekTo(time);
                      revealTime(time);
                    }}
                    aria-label="Previous frame"
                  >
                    <Icon name="back" size={16} />
                  </button>
                  <button
                    disabled={!state.ready}
                    onClick={toggle}
                    aria-label={state.playing ? "Pause" : "Play"}
                    className="mx-[2px] flex h-[28px] w-[34px] items-center justify-center rounded-[4px] bg-[#c0adfa] text-[#1b1530] hover:bg-[#d0c0ff] disabled:opacity-40"
                  >
                    <Icon name={state.playing ? "pause" : "play"} size={17} />
                  </button>
                  <button
                    className={control}
                    disabled={!state.ready}
                    onClick={() => {
                      const time = state.time + 1 / state.fps;
                      seekTo(time);
                      revealTime(time);
                    }}
                    aria-label="Next frame"
                  >
                    <Icon name="next" size={16} />
                  </button>
                </div>
                <div className="font-mono text-[11px] tabular-nums">
                  <span>{clock(state.time)}</span>
                  <span className="mx-[8px] text-[#626878]">/</span>
                  <span className="text-[#a1a5b5]">
                    {clock(project.duration)}
                  </span>
                </div>
                <div className="flex items-center gap-[8px] text-[11px] text-[#a1a5b5]">
                  <button
                    type="button"
                    aria-label={state.masterMuted ? "Unmute mix" : "Mute mix"}
                    aria-pressed={state.masterMuted}
                    onClick={() => {
                      mix().unlock();
                      dispatch({ type: "toggleMasterMute" });
                    }}
                    className={`flex h-[22px] w-[22px] items-center justify-center rounded-[3px] border text-[11px] font-semibold ${state.masterMuted ? "border-[#baa5ff] bg-[#2a2438] text-[#e4d8ff]" : "border-[#3a3d49] text-[#b7bac8]"}`}
                  >
                    M
                  </button>
                  <input
                    aria-label="Preview volume"
                    type="range"
                    min={-60}
                    max={0}
                    step={1}
                    value={state.volumeDb}
                    onChange={(e) =>
                      dispatch({
                        type: "setVolume",
                        volumeDb: Number(e.target.value),
                      })
                    }
                    className="w-[88px] accent-[#baa5ff]"
                  />
                </div>
                <span className="text-[11px] tabular-nums text-[#a1a5b5]">
                  Frame{" "}
                  {Math.min(
                    Math.floor(state.time * state.fps),
                    frameCount(project.duration, state.fps) - 1,
                  )
                    .toString()
                    .padStart(3, "0")}{" "}
                  <span className="text-[#646a7c]">
                    / {frameCount(project.duration, state.fps)}
                  </span>
                </span>
              </div>
            </div>
          </section>
          <aside className="space-y-[10px]">
            <section className="rounded-[8px] border border-[#30323c] bg-[#1b1d23] p-[12px]">
              <h2 className="mb-[2px] text-[13px] font-medium">Export video</h2>
              <p className="mb-[10px] text-[11px] leading-[1.4] text-[#a8abb9]">
                From source to a shareable MP4.
                <br />
                Rendered locally in your browser.
              </p>
              <label
                className="mb-[4px] block text-[11px] text-[#c0c3d0]"
                htmlFor="resolution"
              >
                Resolution
              </label>
              <select
                id="resolution"
                disabled={state.exporting}
                value={state.resolution}
                onChange={(e) => patch({ resolution: e.target.value })}
                className="mb-[8px] h-[30px] w-full rounded-[4px] border border-[#393c48] bg-[#23252d] px-[8px] text-[12px]"
              >
                <option value="640x360">640 × 360 · 360p</option>
                <option value="1280x720">1280 × 720 · 720p</option>
                <option value="1920x1080">1920 × 1080 · 1080p</option>
              </select>
              <label
                className="mb-[4px] block text-[11px] text-[#c0c3d0]"
                htmlFor="fps"
              >
                Frame rate
              </label>
              <select
                id="fps"
                disabled={state.exporting}
                value={state.fps}
                onChange={(e) => patch({ fps: Number(e.target.value) })}
                className="h-[30px] w-full rounded-[4px] border border-[#393c48] bg-[#23252d] px-[8px] text-[12px]"
              >
                {[24, 30, 60].map((f) => (
                  <option key={f} value={f}>
                    {f} FPS
                  </option>
                ))}
              </select>
              <div className="my-[10px] space-y-[4px] border-y border-[#30323c] py-[8px] text-[11px]">
                <div className="flex justify-between">
                  <span className="text-[#a8abb9]">Format</span>
                  <span>
                    {(project.audioTracks ?? []).length
                      ? "MP4 / H.264 / AAC"
                      : "MP4 / H.264"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#a8abb9]">Duration</span>
                  <span>{project.duration} seconds</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#a8abb9]">Total frames</span>
                  <span>{frameCount(project.duration, state.fps)}</span>
                </div>
              </div>
              <button
                onClick={() => void startExport()}
                disabled={!state.ready || state.exporting}
                className="flex h-[32px] w-full items-center justify-center gap-[6px] rounded-[4px] bg-[#baa5ff] text-[12px] font-semibold text-[#201735] hover:bg-[#ccbaff] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Icon name="export" size={16} />
                {state.exporting ? "Exporting…" : "Export Video"}
              </button>
              {state.exporting ? (
                <div className="mt-[14px] text-[12px]">
                  <progress
                    aria-label="Export progress"
                    value={state.done}
                    max={state.total}
                    className="h-[5px] w-full accent-[#baa5ff]"
                  />
                  <div className="mt-[8px] flex justify-between text-[#b5b9c8]">
                    <span>
                      {state.done} / {state.total} frames
                    </span>
                    <button
                      onClick={() => abort.current?.abort()}
                      className="text-[#d7c8ff] hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-[12px] text-center text-[11px] text-[#a8abb9]">
                  Local mix · No upload required
                </p>
              )}
              {state.result && (
                <div
                  role="status"
                  className="mt-[16px] text-[12px] leading-[1.7] text-[#a9daca]"
                >
                  {state.result}
                  {state.download && (
                    <a
                      href={state.download}
                      download="source-to-motion.mp4"
                      className="block text-[#d1c0ff] underline underline-offset-4"
                    >
                      Download MP4 again
                    </a>
                  )}
                </div>
              )}
            </section>
            <section className="px-[3px]">
              <div className="mb-[4px] flex items-center gap-[6px] text-[12px] text-[#cec4e8]">
                <Icon name="code" size={16} />
                <h2>Authored in code</h2>
              </div>
              <p className="text-[11px] leading-[1.4] text-[#9da2b3]">
                Scenes live in your project files. Change the source, and the
                preview updates automatically.
              </p>
              <div className="mt-[6px] rounded-[4px] border border-[#2d303a] bg-[#181a20] px-[8px] py-[5px] font-mono text-[11px] text-[#b2a5d1]">
                src/project/manifest.ts
              </div>
            </section>
          </aside>
        </div>
        <section
          aria-label="Read-only composition timeline"
          className="mt-[12px] overflow-hidden rounded-[8px] border border-[#30323c] bg-[#1b1d23]"
        >
          <div className="flex min-h-[32px] flex-wrap items-center justify-between gap-x-[8px] gap-y-[4px] border-b border-[#2c2f38] px-[8px] py-[4px]">
            <div className="flex items-center gap-[8px]">
              <h2 className="text-[12px] font-medium">Timeline</h2>
              <span className="text-[11px] text-[#9aa0b2]">
                V1 · {(project.audioTracks ?? []).length} audio
              </span>
              <span className="font-mono text-[11px] tabular-nums text-[#d5d8e4]">
                {clock(state.time)}
              </span>
            </div>
            <div className="flex items-center gap-[4px]">
              <span className="mr-[4px] hidden text-[11px] text-[#8b90a3] sm:inline">
                Read-only
              </span>
              <button
                type="button"
                className={miniButton}
                aria-label="Zoom timeline out"
                onClick={() => applyTlZoom(state.tlZoom / 1.25, null)}
              >
                −
              </button>
              <input
                aria-label="Timeline zoom"
                type="range"
                min={0}
                max={1000}
                value={Math.round(
                  (Math.log(state.tlZoom) / Math.log(TL_ZOOM_MAX)) * 1000,
                )}
                onChange={(event) =>
                  applyTlZoom(
                    Math.pow(TL_ZOOM_MAX, Number(event.target.value) / 1000),
                    null,
                  )
                }
                className="w-[88px] accent-[#baa5ff]"
              />
              <button
                type="button"
                className={miniButton}
                aria-label="Zoom timeline in"
                onClick={() => applyTlZoom(state.tlZoom * 1.25, null)}
              >
                +
              </button>
              <button
                type="button"
                className={miniButton}
                aria-label="Fit timeline"
                onClick={() => {
                  pendingScroll.current = 0;
                  dispatch({ type: "tlZoom", zoom: 1 });
                }}
              >
                Fit
              </button>
            </div>
          </div>
          <div className="flex min-w-0">
            <div className="w-[92px] shrink-0 border-r border-[#2c2f38] bg-[#181a20]">
              <div className="h-[28px] border-b border-[#2a2d36]" />
              <TrackHeader label="V1" />
              {(project.audioTracks ?? []).map((track) => (
                <TrackHeader
                  key={track.id}
                  label={track.name}
                  muted={state.mutedTrackIds.includes(track.id)}
                  onMute={() =>
                    dispatch({ type: "toggleTrackMute", id: track.id })
                  }
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
                  seekTo(timeAtClient(event.clientX));
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
                    seekTo(timeAtClient(event.clientX));
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
                <div className="relative h-[28px] overflow-hidden border-b border-[#2a2d36] bg-[#16181e]">
                  {ruler.marks.map((mark, index) => {
                    const left = `${(mark.time / project.duration) * 100}%`;
                    const room =
                      contentWidth -
                      (mark.time / project.duration) * contentWidth;
                    const label = formatRulerTime(mark.time, ruler.major, state.fps);
                    return (
                      <div
                        key={`${index}-${mark.time}`}
                        className="absolute bottom-0"
                        style={{ left }}
                      >
                        <div
                          className={`w-px ${mark.major ? "h-[9px] bg-[#8b90a3]" : "h-[5px] bg-[#3c4050]"}`}
                        />
                        {mark.major && room >= 64 && (
                          <span className="absolute bottom-[10px] left-[4px] whitespace-nowrap font-mono text-[11px] leading-[12px] text-[#9aa0b2]">
                            {label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="pointer-events-none absolute bottom-0 top-[28px] left-0 right-0">
                  {ruler.marks
                    .filter((mark) => mark.major)
                    .map((mark) => (
                      <div
                        key={`grid-${mark.time}`}
                        className="absolute bottom-0 top-0 w-px bg-[#2a2d36]"
                        style={{ left: `${(mark.time / project.duration) * 100}%` }}
                      />
                    ))}
                </div>
                <div className="relative h-[34px] border-b border-[#2a2d36]">
                  {project.scenes.map((scene, index) => (
                    <LaneBlock
                      key={scene.id}
                      start={scene.start}
                      duration={scene.duration}
                      total={project.duration}
                      color={colors[index % colors.length]}
                      title={scene.name}
                      detail={scene.source}
                      active={active.id === scene.id}
                    />
                  ))}
                </div>
                {(project.audioTracks ?? []).map((track, index) => (
                  <div
                    key={track.id}
                    className={`relative h-[34px] border-b border-[#2a2d36] ${state.mutedTrackIds.includes(track.id) ? "opacity-45" : ""}`}
                  >
                    {track.clips.map((clip) => (
                      <LaneBlock
                        key={clip.id}
                        start={clip.start}
                        duration={clip.duration}
                        total={project.duration}
                        color={colors[(index + 1) % colors.length]}
                        title={clip.name}
                        detail={`${clip.duration}s`}
                      />
                    ))}
                  </div>
                ))}
                <div
                  className="pointer-events-none absolute bottom-0 top-0 z-[2] w-px bg-[#f3e8ff]"
                  style={{ left: `${(state.time / project.duration) * 100}%` }}
                >
                  <div
                    className="absolute left-1/2 top-0 h-[8px] w-[9px] -translate-x-1/2 bg-[#f3e8ff]"
                    style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
        <footer className="mt-[8px] flex flex-wrap justify-between gap-[6px] text-[11px] text-[#969cad]">
          <span className="flex items-center gap-[6px]">
            <Icon name="check" size={13} /> Deterministic rendering · Same
            engine, every frame
          </span>
          <span>
            Space plays · ← → step · scroll picture to zoom, drag to pan ·
            timeline scroll pans, ⌘/Ctrl-scroll zooms
          </span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
