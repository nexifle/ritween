import React, { useEffect, useReducer, useRef } from "react";
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
  | { type: "setVolume"; volumeDb: number };
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
const clock = (time: number) =>
  `${Math.floor(time / 60)
    .toString()
    .padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;
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
function TrackRow({
  label,
  muted,
  onMute,
  children,
}: {
  label: string;
  muted?: boolean;
  onMute?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex h-[58px] items-stretch gap-[10px] ${muted ? "opacity-45" : ""}`}>
      <div className="flex w-[78px] shrink-0 items-center justify-between gap-[6px] pr-[4px]">
        <span className="truncate text-[11px] font-medium tracking-[0.4px] text-[#c5c8d6]">
          {label}
        </span>
        {onMute && (
          <button
            type="button"
            aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
            aria-pressed={muted}
            onClick={onMute}
            className={`flex h-[22px] w-[22px] items-center justify-center rounded-[4px] border text-[10px] font-semibold ${muted ? "border-[#baa5ff] bg-[#2a2438] text-[#e4d8ff]" : "border-[#3a3d49] text-[#9aa0b2]"}`}
          >
            M
          </button>
        )}
      </div>
      <div className="relative min-w-0 flex-1">{children}</div>
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
      className="absolute top-[6px] bottom-[6px] overflow-hidden rounded-[5px] border px-[8px] py-[6px]"
      style={{
        left: `${(start / total) * 100}%`,
        width: `${(duration / total) * 100}%`,
        borderColor: active ? color : "#373b4a",
        backgroundColor: `${color}12`,
      }}
    >
      <div className="truncate text-[12px] font-medium" style={{ color }}>
        {title}
      </div>
      <p className="truncate font-mono text-[10px] text-[#9da4b7]">{detail}</p>
    </div>
  );
}
const control =
  "flex h-[34px] w-[34px] items-center justify-center rounded-[6px] text-[#b8bac6] hover:bg-[#30323c] hover:text-white disabled:opacity-40";
function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const abort = useRef<AbortController | null>(null);
  const resultUrl = useRef("");
  const alive = useRef(true);
  const audio = useRef<PreviewAudio | null>(null);
  const timeRef = useRef(0);
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
        seekTo(state.time + (e.code === "ArrowRight" ? 1 : -1) / state.fps);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [state.time, state.playing, state.ready, state.fps]);
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
  return (
    <div className="min-h-screen bg-[#131418] text-[#ececf2]">
      <header className="flex min-h-[76px] flex-wrap items-center justify-between gap-[20px] border-b border-[#2b2d35] px-[28px] md:px-[40px]">
        <a
          href="/"
          className="flex items-center gap-[11px] text-[21px] font-semibold tracking-[-0.6px]"
        >
          <span className="flex h-[29px] w-[29px] items-center justify-center rounded-[8px] bg-[#baa5ff] text-[#181323]">
            <Icon name="film" size={19} />
          </span>
          rimotion
          <span className="ml-[3px] rounded-[4px] border border-[#3b354c] px-[6px] py-[2px] text-[10px] font-medium tracking-[0px] text-[#c1afd8]">
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
      <main className="mx-auto max-w-[1600px] px-[20px] py-[28px] md:px-[40px] md:py-[32px]">
        <div className="mb-[26px] flex flex-wrap items-end justify-between gap-[16px]">
          <div>
            <div className="mb-[8px] flex items-center gap-[8px] text-[12px] text-[#989cab]">
              <span>Projects</span>
              <span className="text-[#535765]">/</span>
              <span className="text-[#d6d7e0]">Demo composition</span>
            </div>
            <h1 className="text-[26px] font-medium leading-[1.2] tracking-[-0.8px]">
              {project.name}
            </h1>
          </div>
          <div className="flex items-center gap-[9px] rounded-[6px] border border-[#31333d] bg-[#1b1d23] px-[12px] py-[8px] text-[12px] text-[#b7bac8]">
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
        <div className="grid items-start gap-[24px] lg:grid-cols-[minmax(0,1fr)_286px]">
          <section
            aria-label="Video preview"
            className="min-w-0 overflow-hidden rounded-[10px] border border-[#30323c] bg-[#1b1d23]"
          >
            <div className="flex h-[47px] items-center justify-between px-[18px] text-[12px]">
              <span className="flex items-center gap-[8px]">
                <Icon name="film" size={15} />
                <span>Preview</span>
              </span>
              <span className="text-[#a1a5b5]">
                {project.resolution[0]} × {project.resolution[1]}{" "}
                <span className="mx-[8px] text-[#4e5260]">/</span>{" "}
                {project.aspectRatio.join(":")}
              </span>
            </div>
            <div
              className="relative bg-[#080e20]"
              style={{
                aspectRatio: project.aspectRatio[0] / project.aspectRatio[1],
              }}
            >
              <canvas
                ref={canvas}
                width={project.resolution[0]}
                height={project.resolution[1]}
                className="block h-full w-full"
                aria-label="WebGPU composition preview"
              />
              {!state.ready && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0d1323]/90 p-[30px] text-center text-[14px] text-[#bac1d6]">
                  {state.error
                    ? "Preview requires an available WebGPU device."
                    : "Preparing scene pipelines…"}
                </div>
              )}
            </div>
            <div className="px-[18px] pb-[12px] pt-[15px]">
              <input
                aria-label="Playback scrubber"
                type="range"
                min={0}
                max={project.duration}
                step={1 / state.fps}
                value={state.time}
                onChange={(e) => seekTo(Number(e.target.value))}
                className="w-full accent-[#baa5ff]"
              />
              <div className="mt-[9px] flex flex-wrap items-center justify-between gap-[8px]">
                <div className="flex items-center gap-[4px]">
                  <button
                    className={control}
                    disabled={!state.ready}
                    onClick={() => seekTo(0)}
                    aria-label="Restart"
                  >
                    <Icon name="restart" size={16} />
                  </button>
                  <button
                    className={control}
                    disabled={!state.ready}
                    onClick={() => seekTo(state.time - 1 / state.fps)}
                    aria-label="Previous frame"
                  >
                    <Icon name="back" size={16} />
                  </button>
                  <button
                    disabled={!state.ready}
                    onClick={toggle}
                    aria-label={state.playing ? "Pause" : "Play"}
                    className="mx-[3px] flex h-[34px] w-[39px] items-center justify-center rounded-[6px] bg-[#c0adfa] text-[#1b1530] hover:bg-[#d0c0ff] disabled:opacity-40"
                  >
                    <Icon name={state.playing ? "pause" : "play"} size={17} />
                  </button>
                  <button
                    className={control}
                    disabled={!state.ready}
                    onClick={() => seekTo(state.time + 1 / state.fps)}
                    aria-label="Next frame"
                  >
                    <Icon name="next" size={16} />
                  </button>
                </div>
                <div className="font-mono text-[12px] tabular-nums">
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
                    className={`flex h-[28px] w-[28px] items-center justify-center rounded-[5px] border text-[10px] font-semibold ${state.masterMuted ? "border-[#baa5ff] bg-[#2a2438] text-[#e4d8ff]" : "border-[#3a3d49] text-[#b7bac8]"}`}
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
          <aside className="space-y-[20px]">
            <section className="rounded-[10px] border border-[#30323c] bg-[#1b1d23] p-[20px]">
              <h2 className="mb-[6px] text-[15px] font-medium">Export video</h2>
              <p className="mb-[23px] text-[12px] leading-[1.65] text-[#a8abb9]">
                From source to a shareable MP4.
                <br />
                Rendered locally in your browser.
              </p>
              <label
                className="mb-[7px] block text-[12px] text-[#c0c3d0]"
                htmlFor="resolution"
              >
                Resolution
              </label>
              <select
                id="resolution"
                disabled={state.exporting}
                value={state.resolution}
                onChange={(e) => patch({ resolution: e.target.value })}
                className="mb-[18px] h-[39px] w-full rounded-[6px] border border-[#393c48] bg-[#23252d] px-[11px] text-[13px]"
              >
                <option value="640x360">640 × 360 · 360p</option>
                <option value="1280x720">1280 × 720 · 720p</option>
                <option value="1920x1080">1920 × 1080 · 1080p</option>
              </select>
              <label
                className="mb-[7px] block text-[12px] text-[#c0c3d0]"
                htmlFor="fps"
              >
                Frame rate
              </label>
              <select
                id="fps"
                disabled={state.exporting}
                value={state.fps}
                onChange={(e) => patch({ fps: Number(e.target.value) })}
                className="h-[39px] w-full rounded-[6px] border border-[#393c48] bg-[#23252d] px-[11px] text-[13px]"
              >
                {[24, 30, 60].map((f) => (
                  <option key={f} value={f}>
                    {f} FPS
                  </option>
                ))}
              </select>
              <div className="my-[21px] space-y-[10px] border-y border-[#30323c] py-[16px] text-[12px]">
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
                className="flex h-[42px] w-full items-center justify-center gap-[9px] rounded-[6px] bg-[#baa5ff] text-[13px] font-semibold text-[#201735] hover:bg-[#ccbaff] disabled:cursor-not-allowed disabled:opacity-45"
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
              <div className="mb-[10px] flex items-center gap-[8px] text-[12px] text-[#cec4e8]">
                <Icon name="code" size={16} />
                <h2>Authored in code</h2>
              </div>
              <p className="text-[12px] leading-[1.8] text-[#9da2b3]">
                Scenes live in your project files. Change the source, and the
                preview updates automatically.
              </p>
              <div className="mt-[13px] rounded-[5px] border border-[#2d303a] bg-[#181a20] px-[10px] py-[9px] font-mono text-[10px] text-[#b2a5d1]">
                src/project/manifest.ts
              </div>
            </section>
          </aside>
        </div>
        <section
          aria-label="Read-only composition timeline"
          className="mt-[26px] overflow-hidden rounded-[10px] border border-[#30323c] bg-[#1b1d23]"
        >
          <div className="flex h-[51px] items-center justify-between border-b border-[#2c2f38] px-[20px]">
            <div className="flex items-center gap-[10px]">
              <h2 className="text-[14px] font-medium">Composition</h2>
              <span className="rounded-[4px] bg-[#292c36] px-[6px] py-[2px] text-[10px] text-[#b8bdce]">
                V1 · {(project.audioTracks ?? []).length} audio
              </span>
            </div>
            <span className="text-[11px] text-[#9ca2b4]">
              Read-only timeline
            </span>
          </div>
          <div className="px-[20px] pb-[18px] pt-[14px]">
            <div className="mb-[8px] flex justify-between pl-[88px] font-mono text-[10px] text-[#969caf]">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i}>
                  {Number(((i * project.duration) / 8).toFixed(2))}s
                </span>
              ))}
            </div>
            <div className="relative">
              <TrackRow label="V1">
                {project.scenes.map((s, i) => (
                  <LaneBlock
                    key={s.id}
                    start={s.start}
                    duration={s.duration}
                    total={project.duration}
                    color={colors[i % colors.length]}
                    title={s.name}
                    detail={s.source}
                    active={active.id === s.id}
                  />
                ))}
              </TrackRow>
              {(project.audioTracks ?? []).map((track, i) => {
                const muted = state.mutedTrackIds.includes(track.id);
                return (
                  <TrackRow
                    key={track.id}
                    label={track.name}
                    muted={muted}
                    onMute={() =>
                      dispatch({ type: "toggleTrackMute", id: track.id })
                    }
                  >
                    {track.clips.map((clip) => (
                      <LaneBlock
                        key={clip.id}
                        start={clip.start}
                        duration={clip.duration}
                        total={project.duration}
                        color={colors[(i + 1) % colors.length]}
                        title={clip.name}
                        detail={`${clip.duration}s`}
                      />
                    ))}
                  </TrackRow>
                );
              })}
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-[1px] bg-[#e0d3ff]"
                style={{
                  left: `calc(88px + (100% - 88px) * ${state.time / project.duration})`,
                }}
              >
                <div className="absolute left-[-4px] top-[-3px] h-[8px] w-[9px] rounded-b-[2px] bg-[#e0d3ff]" />
              </div>
            </div>
          </div>
        </section>
        <footer className="mt-[19px] flex flex-wrap justify-between gap-[8px] text-[11px] text-[#969cad]">
          <span className="flex items-center gap-[6px]">
            <Icon name="check" size={13} /> Deterministic rendering · Same
            engine, every frame
          </span>
          <span>
            Space to play / pause{" "}
            <span className="mx-[8px] text-[#4e5361]">|</span> ← → to step
            frames
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
