import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { PreviewAudio } from "../engine/audio";
import { exportSizes } from "../engine/export-size";
import { Renderer } from "../engine/renderer";
import { evaluate, frameCount } from "../engine/timeline";
import { project } from "virtual:ritween-project";
import { sources } from "virtual:ritween-sources";
import { CompositionViewer } from "./composition/composition-viewer";
import { ErrorBanner } from "./components/error-banner";
import { ExportPanel } from "./export/export-panel";
import { ProjectHeading } from "./layout/project-heading";
import {
  dockPaneStyle,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/resizable";
import { SceneSource } from "./source/scene-source";
import { SidebarPanel } from "./components/sidebar-panel";
import { initial, reducer } from "./state/preview-state";
import { StudioDock } from "./layout/studio-dock";
import { StudioFooter } from "./layout/studio-footer";
import { StudioHeader } from "./layout/studio-header";
import { Timeline, type TimelineHandle } from "./timeline/timeline";
import { Transport } from "./playback/transport";

export function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const abort = useRef<AbortController | null>(null);
  const resultUrl = useRef("");
  const alive = useRef(true);
  const audio = useRef<PreviewAudio | null>(null);
  const timeRef = useRef(0);
  const timelineRef = useRef<TimelineHandle>(null);
  const inspectorLayout = useDefaultLayout({
    id: "ritween-inspector",
    onlySaveAfterUserInteractions: true,
  });
  const patch = (value: Partial<typeof state>) =>
    dispatch({ type: "patch", value });
  const mix = () => {
    if (!audio.current) audio.current = new PreviewAudio();
    return audio.current;
  };
  timeRef.current = state.time;
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const initialization = new AbortController();
    const player = mix();
    const picture = Renderer.create(
      canvas.current!,
      project,
      (error) => {
        if (!cancelled) patch({ error, playing: false, ready: false });
      },
      initialization.signal,
    ).then((r) => {
      if (cancelled) {
        r.dispose();
        return;
      }
      renderer.current = r;
      r.render(0);
    });
    // Download/decode and record the score alongside GPU setup. Once the
    // transport is enabled, first Play has the same prepared score as replay.
    void Promise.all([picture, player.prepare(project)])
      .then(() => {
        if (!cancelled) patch({ ready: true });
      })
      .catch((e) => {
        if (!cancelled) {
          patch({ error: String(e instanceof Error ? e.message : e) });
          cancelled = true;
          initialization.abort();
          player.dispose();
          renderer.current?.dispose();
          renderer.current = null;
        }
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
    audio.current?.setMuted(state.mutedTrackIds);
  }, [mutedKey]);
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
      if (player.isBlocking()) {
        last = now;
        id = requestAnimationFrame(tick);
        return;
      }
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
  }, [state.playing]);
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) dispatch({ type: "pause" });
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  const toggle = () => {
    if (!state.ready || state.exporting) return;
    if (
      !state.playing &&
      project.audioTracks?.some((track) => track.clips.length)
    )
      mix().unlock();
    dispatch({ type: "toggle" });
  };
  const seekTo = (time: number) => {
    dispatch({ type: "seek", time });
    if (state.playing)
      audio.current?.seek(Math.max(0, Math.min(project.duration, time)));
  };
  const seekAndReveal = (time: number) => {
    seekTo(time);
    timelineRef.current?.reveal(time);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        ["INPUT", "SELECT", "BUTTON", "A"].includes(target.tagName) ||
        target.closest("[data-slot=resizable-handle]") ||
        target.closest("[data-scene-source]")
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      }
      if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
        e.preventDefault();
        const time =
          state.time + (e.code === "ArrowRight" ? 1 : -1) / state.fps;
        seekAndReveal(time);
      }
      if (e.key === "-" || e.key === "_" || e.key === "=" || e.key === "+") {
        e.preventDefault();
        const zoomingIn = e.key === "=" || e.key === "+";
        timelineRef.current?.zoomAroundTime(zoomingIn ? 1.25 : 0.8, state.time);
      }
      if (e.key === "\\") {
        e.preventDefault();
        timelineRef.current?.fit();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [state.time, state.playing, state.ready, state.fps, state.exporting]);
  async function startExport() {
    const controller = new AbortController();
    abort.current = controller;
    audio.current?.stop();
    patch({
      playing: false,
      exporting: true,
      exportStage: "Preparing export…",
      done: 0,
      total: frameCount(project.duration, state.fps),
      error: "",
      result: "",
    });
    const activeStages = new Set<string>();
    const stageLabels: Record<string, string> = {
      "audio-mix": "Mixing audio",
      "audio-encode": "Encoding audio",
      "scene-setup": "Preparing scenes",
      "video-encode": "Encoding video",
      mux: "Finalizing MP4",
    };
    const showStages = () => {
      if (alive.current && activeStages.size)
        patch({
          exportStage:
            [...activeStages].map((stage) => stageLabels[stage]).join(" + ") +
            "…",
        });
    };
    const [width, height] = state.resolution.split("x").map(Number);
    try {
      const { exportVideo } = await import("../engine/export");
      const result = await exportVideo(project, {
        width,
        height,
        fps: state.fps,
        bitrate: state.bitrate || undefined,
        latencyMode: state.latencyMode,
        keyFrameInterval: state.keyFrameInterval,
        mutedTrackIds: state.mutedTrackIds,
        signal: controller.signal,
        onStage: (stage) => {
          activeStages.add(stage);
          showStages();
        },
        onStageComplete: (stage) => {
          activeStages.delete(stage);
          showStages();
        },
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
  const pinSource = useCallback(
    (id: string) => dispatch({ type: "pinSource", id }),
    [],
  );
  const followSource = useCallback(
    () => dispatch({ type: "followSource" }),
    [],
  );
  const expandSource = useCallback(
    () => dispatch({ type: "setSourceOpen", open: true }),
    [],
  );
  const [exportCollapsed, setExportCollapsed] = useState(false);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);

  const sceneSource = (
    <SceneSource
      scenes={project.scenes}
      sources={sources}
      activeId={active.id}
      pinnedId={state.pinnedSourceId}
      expanded={state.sourceOpen}
      collapsed={sourceCollapsed}
      onToggleCollapse={(next) => setSourceCollapsed(next)}
      onPin={pinSource}
      onFollow={followSource}
      onExpand={state.sourceOpen ? undefined : expandSource}
    />
  );

  const renderExport = (collapsed: boolean, borderTop = false) => (
    <ExportPanel
      ready={state.ready}
      exporting={state.exporting}
      stage={state.exportStage}
      resolution={state.resolution}
      sizes={exportSizes(project.resolution)}
      aspectRatio={project.aspectRatio}
      fps={state.fps}
      bitrate={state.bitrate}
      latencyMode={state.latencyMode}
      keyFrameInterval={state.keyFrameInterval}
      onBitrate={(bitrate) => patch({ bitrate })}
      onLatencyMode={(latencyMode) => patch({ latencyMode })}
      onKeyFrameInterval={(keyFrameInterval) => patch({ keyFrameInterval })}
      duration={project.duration}
      hasAudio={(project.audioTracks ?? []).length > 0}
      done={state.done}
      total={state.total}
      result={state.result}
      download={state.download}
      collapsed={collapsed}
      borderTop={borderTop}
      onToggleCollapse={(next) => setExportCollapsed(next)}
      onResolution={(resolution) => patch({ resolution })}
      onFps={(fps) => patch({ fps })}
      onExport={() => void startExport()}
      onCancel={() => abort.current?.abort()}
    />
  );

  const renderSource = (collapsed: boolean, borderTop = false) =>
    state.sourceOpen ? (
      <SidebarPanel
        icon="code"
        title="Scene source"
        collapsed={collapsed}
        borderTop={borderTop}
        onToggleCollapse={(next) => setSourceCollapsed(next)}
        contentClassName="p-3"
      >
        <p className="text-[11px] leading-[1.4] text-hint-foreground">
          Scene source is open on the composition. Choose Picture to read it
          here again.
        </p>
      </SidebarPanel>
    ) : (
      <SceneSource
        scenes={project.scenes}
        sources={sources}
        activeId={active.id}
        pinnedId={state.pinnedSourceId}
        expanded={state.sourceOpen}
        collapsed={collapsed}
        borderTop={borderTop}
        onToggleCollapse={(next) => setSourceCollapsed(next)}
        onPin={pinSource}
        onFollow={followSource}
        onExpand={state.sourceOpen ? undefined : expandSource}
      />
    );

  let inspectorContent: ReactNode;
  if (exportCollapsed && sourceCollapsed) {
    inspectorContent = (
      <div className="flex h-full w-full flex-col overflow-hidden bg-card">
        <div className="h-8 shrink-0">{renderExport(true)}</div>
        <div className="h-8 shrink-0">{renderSource(true)}</div>
        <div className="flex-1 min-h-0 bg-canvas/30" />
      </div>
    );
  } else if (exportCollapsed) {
    inspectorContent = (
      <div className="flex h-full w-full flex-col overflow-hidden bg-card">
        <div className="h-8 shrink-0">{renderExport(true)}</div>
        <div className="flex flex-1 min-h-0 flex-col">
          {renderSource(false)}
        </div>
      </div>
    );
  } else if (sourceCollapsed) {
    inspectorContent = (
      <div className="flex h-full w-full flex-col overflow-hidden bg-card">
        <div className="flex flex-1 min-h-0 flex-col">
          {renderExport(false)}
        </div>
        <div className="h-8 shrink-0">{renderSource(true, true)}</div>
      </div>
    );
  } else {
    inspectorContent = (
      <ResizablePanelGroup
        id="ritween-inspector"
        orientation="vertical"
        defaultLayout={inspectorLayout.defaultLayout}
        onLayoutChanged={inspectorLayout.onLayoutChanged}
      >
        <ResizablePanel
          id="export"
          defaultSize="48%"
          minSize="20%"
          style={dockPaneStyle}
        >
          <div className="absolute inset-0 flex min-h-0 flex-col">
            {renderExport(false)}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="source"
          defaultSize="52%"
          minSize="20%"
          style={dockPaneStyle}
        >
          <div className="absolute inset-0 flex min-h-0 flex-col">
            {renderSource(false)}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <StudioHeader />
      <ErrorBanner error={state.error} />
      <main className="min-h-0 flex-1">
        <StudioDock
          viewer={
            <>
              <ProjectHeading
                name={project.name}
                ready={state.ready}
                error={state.error}
              />
              <CompositionViewer
                resolution={project.resolution}
                aspectRatio={project.aspectRatio}
                zoom={state.compZoom}
                panX={state.compPanX}
                panY={state.compPanY}
                ready={state.ready}
                error={state.error}
                canvasRef={canvas}
                onView={(zoom, panX, panY) =>
                  dispatch({ type: "compView", zoom, panX, panY })
                }
                sourceOpen={state.sourceOpen}
                onToggleSource={() =>
                  dispatch({ type: "setSourceOpen", open: !state.sourceOpen })
                }
                source={state.sourceOpen ? sceneSource : null}
              >
                <Transport
                  ready={state.ready && !state.exporting}
                  playing={state.playing}
                  time={state.time}
                  duration={project.duration}
                  fps={state.fps}
                  volumeDb={state.volumeDb}
                  masterMuted={state.masterMuted}
                  onSeek={seekAndReveal}
                  onToggle={toggle}
                  onMasterMute={() => {
                    dispatch({ type: "toggleMasterMute" });
                  }}
                  onVolume={(volumeDb) =>
                    dispatch({ type: "setVolume", volumeDb })
                  }
                />
              </CompositionViewer>
            </>
          }
          inspector={inspectorContent}
          timeline={
            <Timeline
              ref={timelineRef}
              duration={project.duration}
              fps={state.fps}
              time={state.time}
              playing={state.playing}
              zoom={state.tlZoom}
              scenes={project.scenes}
              audioTracks={project.audioTracks ?? []}
              activeSceneId={active.id}
              mutedTrackIds={state.mutedTrackIds}
              onZoom={(zoom) => dispatch({ type: "tlZoom", zoom })}
              onSeek={seekTo}
              onToggleMute={(id) => dispatch({ type: "toggleTrackMute", id })}
              onOpenSource={pinSource}
            />
          }
        />
      </main>
      <StudioFooter />
    </div>
  );
}
