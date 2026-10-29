import { projectExportSettings } from "../engine/export/project-settings";
import { exportFilename } from "../engine/export/filename";
import { audibleAudioTracks } from "../engine/project-settings";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePersistentLayout } from "./hooks/use-persistent-layout";
import { saveStudioPreferences } from "./state/studio-preferences";
import { PreviewAudio } from "../engine/render/audio";
import { exportSizes } from "../engine/export/formats/mp4/sizes";
import { Renderer } from "../engine/render/renderer";
import { evaluate, frameCount } from "../engine/timeline";
import { getSnapshot, subscribe } from "virtual:ritween-live";
import { useProjectSettings } from "./state/use-project-settings";
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
import { initial, reducer, createInitialState } from "./state/preview-state";
import { StudioDock } from "./layout/studio-dock";
import { StudioFooter } from "./layout/studio-footer";
import { StudioHeader } from "./layout/studio-header";
import { Timeline, type TimelineHandle } from "./timeline/timeline";
import { Transport } from "./playback/transport";

import { resolveMediaProject } from "../engine/media/project";

export function App() {
  const incoming = useSyncExternalStore(subscribe, getSnapshot);
  const [committed, setCommitted] = useState(() => ({
    ...incoming,
    project: resolveMediaProject(incoming.project),
  }));
  const { project: sourceProject, authoredSettings, savedSettings } = committed;
  const { sources } = incoming;
  const {
    project,
    mutedTrackIds,
    mutedClipIds,
    toggleTrackMute,
    toggleClipMute,
    updateExportSettings,
    saving: savingSettings,
    error: settingsError,
  } = useProjectSettings(sourceProject, authoredSettings, savedSettings);
  const filename = exportFilename(project.name);
  const exportSettings = projectExportSettings(project);
  const exportFps = exportSettings.fps;
  const exportBitrate =
    exportSettings.bitrate === "auto" ? 0 : exportSettings.bitrate;
  const exportLatencyMode = exportSettings.latencyMode;
  const exportKeyFrameInterval = exportSettings.keyFrameInterval;
  const sizes = exportSizes(project.resolution);
  if (
    project.settings?.export?.resolution &&
    !sizes.some(
      (size) =>
        size.width === exportSettings.width &&
        size.height === exportSettings.height,
    )
  )
    sizes.push({ width: exportSettings.width, height: exportSettings.height });
  const exportResolution = sizes.length
    ? `${exportSettings.width}x${exportSettings.height}`
    : "";
  const [state, dispatch] = useReducer(reducer, initial, createInitialState);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const abort = useRef<AbortController | null>(null);
  const resultUrl = useRef("");
  const alive = useRef(true);
  const audio = useRef<PreviewAudio | null>(null);
  const timeRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const appliedRevision = useRef(-1);
  const resumeAfterUpdate = useRef(false);
  const previewRequest = useRef<number | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const previewActiveTime = useRef<number | null>(null);
  const previewRunning = useRef(false);
  const renderedPreviewTime = useRef<number | null>(null);
  const timelineRef = useRef<TimelineHandle>(null);
  const inspectorLayout = usePersistentLayout("ritween-inspector", [
    "export",
    "source",
  ]);
  useEffect(() => {
    saveStudioPreferences({
      tlZoom: state.tlZoom,
      volumeDb: state.volumeDb,
      masterMuted: state.masterMuted,
      sourceOpen: state.sourceOpen,
      exportCollapsed: state.exportCollapsed,
      sourceCollapsed: state.sourceCollapsed,
    });
  }, [
    state.tlZoom,
    state.volumeDb,
    state.masterMuted,
    state.sourceOpen,
    state.exportCollapsed,
    state.sourceCollapsed,
  ]);
  const patch = (value: Partial<typeof state>) =>
    dispatch({ type: "patch", value });
  const mix = () => {
    if (!audio.current) audio.current = new PreviewAudio();
    return audio.current;
  };
  const requestPreviewFrame = (time: number) => {
    if (
      previewActiveTime.current === time &&
      !previewAbort.current?.signal.aborted
    ) {
      previewRequest.current = null;
      return;
    }
    previewRequest.current = time;
    if (previewRunning.current) return;

    previewRunning.current = true;
    const renderLatest = async () => {
      try {
        while (previewRequest.current !== null && alive.current) {
          const next = previewRequest.current;
          previewRequest.current = null;
          const controller = new AbortController();
          previewAbort.current = controller;
          previewActiveTime.current = next;
          try {
            const activeRenderer = renderer.current;
            if (!activeRenderer) break;
            await activeRenderer.renderAsync(next, controller.signal);
            if (!controller.signal.aborted && timeRef.current === next)
              renderedPreviewTime.current = next;
          } catch (error) {
            const isAbort =
              controller.signal.aborted ||
              (error as { name?: string } | null)?.name === "AbortError";
            if (!isAbort && alive.current)
              patch({
                error: error instanceof Error ? error.message : String(error),
                playing: false,
                ready: false,
              });
          } finally {
            if (previewAbort.current === controller)
              previewAbort.current = null;
            if (previewActiveTime.current === next)
              previewActiveTime.current = null;
          }
        }
      } finally {
        previewRunning.current = false;
      }
    };
    void renderLatest().catch((error) => {
      if (
        alive.current &&
        (error as { name?: string } | null)?.name !== "AbortError"
      )
        patch({
          error: error instanceof Error ? error.message : String(error),
          playing: false,
          ready: false,
        });
    });
  };
  timeRef.current = state.time;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      appliedRevision.current = -1;
      previewRequest.current = null;
      previewAbort.current?.abort();
      abort.current?.abort();
      renderer.current?.dispose();
      renderer.current = null;
      audio.current?.dispose();
      audio.current = null;
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
    };
  }, []);
  useEffect(() => {
    if (incoming.error) patch({ error: incoming.error });
  }, [incoming.error]);
  useEffect(() => {
    // An export owns its project snapshot until it finishes. Only the latest
    // incoming revision is prepared once the export releases its resources.
    if (state.exporting || appliedRevision.current === incoming.revision)
      return;
    const initialization = new AbortController();
    let candidate: Renderer | null = null;
    const player = new PreviewAudio();
    let installed = false;
    if (!stateRef.current.updating)
      resumeAfterUpdate.current = stateRef.current.playing;
    patch({ updating: true, playing: false });
    audio.current?.stop();
    previewRequest.current = null;
    previewAbort.current?.abort();

    const prepare = async () => {
      const next = resolveMediaProject(incoming.project);
      const staging = document.createElement("canvas");
      [staging.width, staging.height] = next.resolution;
      let gpuError = "";
      const picture = Renderer.create(
        staging,
        next,
        (error) => {
          gpuError = error;
          if (installed && renderer.current === candidate)
            patch({ error, playing: false });
        },
        initialization.signal,
      ).then((value) => {
        candidate = value;
        if (initialization.signal.aborted) value.dispose();
        initialization.signal.throwIfAborted();
        return value;
      });
      await Promise.all([picture, player.prepare(next)]);
      initialization.signal.throwIfAborted();
      const time = Math.min(timeRef.current, next.duration);
      await candidate!.renderAsync(time, initialization.signal);
      initialization.signal.throwIfAborted();
      if (gpuError) throw Error(gpuError);

      // Setup and the first frame succeeded without touching the active canvas.
      // Transfer ownership synchronously; disposal must not unconfigure its new owner.
      const previous = renderer.current;
      previous?.detachCanvas();
      try {
        candidate!.attachCanvas(canvas.current!);
      } catch (error) {
        candidate?.dispose();
        candidate = null;
        previous?.attachCanvas(canvas.current!);
        renderedPreviewTime.current = null;
        requestPreviewFrame(timeRef.current);
        throw error;
      }
      renderer.current = candidate;
      const previousAudio = audio.current;
      audio.current = player;
      installed = true;
      previous?.dispose();
      previousAudio?.dispose();
      player.setMonitor(
        stateRef.current.volumeDb,
        stateRef.current.masterMuted,
      );
      renderedPreviewTime.current = null;
      timeRef.current = time;
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
      resultUrl.current = "";
      appliedRevision.current = incoming.revision;
      setCommitted({ ...incoming, project: next });
      dispatch({
        type: "project",
        duration: next.duration,
        total: frameCount(next.duration, projectExportSettings(next).fps),
        sceneIds: next.scenes.map((scene) => scene.id),
        playing: resumeAfterUpdate.current,
      });
      if (getSnapshot().error) patch({ error: getSnapshot().error });
    };
    void prepare().catch((error) => {
      if (!initialization.signal.aborted)
        patch({
          updating: false,
          error: error instanceof Error ? error.message : String(error),
        });
      initialization.abort();
      if (!installed) {
        candidate?.dispose();
        player.dispose();
      }
    });
    return () => {
      if (!installed) {
        initialization.abort();
        candidate?.dispose();
        player.dispose();
      }
    };
  }, [incoming.revision, state.exporting]);
  useEffect(() => {
    if (!state.ready) {
      previewRequest.current = null;
      previewAbort.current?.abort();
      return;
    }
    if (renderedPreviewTime.current !== state.time || previewRunning.current)
      requestPreviewFrame(state.time);
  }, [state.time, state.ready, committed.revision]);
  const mutedKey = JSON.stringify([mutedTrackIds, mutedClipIds]);
  useEffect(() => {
    void audio.current?.setMuted(mutedTrackIds, mutedClipIds).catch((error) => {
      const isAbort =
        (error as { name?: string } | null)?.name === "AbortError";
      if (alive.current && !isAbort)
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
    });
  }, [mutedKey, committed.revision]);
  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    player.setMonitor(state.volumeDb, state.masterMuted);
  }, [state.volumeDb, state.masterMuted, committed.revision]);
  useEffect(() => {
    if (!state.playing) {
      audio.current?.stop();
      return;
    }
    const player = mix();
    player.setMonitor(state.volumeDb, state.masterMuted);
    let cancelled = false;
    void player
      .play(timeRef.current, project, mutedTrackIds, mutedClipIds)
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
  }, [state.playing, committed.revision]);
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) {
        resumeAfterUpdate.current = false;
        dispatch({ type: "pause" });
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  const toggle = () => {
    if (!state.ready || state.updating || state.exporting) return;
    if (
      !state.playing &&
      project.audioTracks?.some((track) => track.clips.length)
    )
      mix().unlock();
    dispatch({ type: "toggle" });
  };
  const seekTo = (time: number) => {
    const target = Math.max(0, Math.min(project.duration, time));
    timeRef.current = target;
    if (
      previewActiveTime.current === target &&
      !previewAbort.current?.signal.aborted
    )
      previewRequest.current = null;
    else {
      previewAbort.current?.abort();
      previewRequest.current = null;
      if (state.ready) requestPreviewFrame(target);
    }
    dispatch({ type: "seek", time });
    if (state.playing) audio.current?.seek(target);
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
          state.time + (e.code === "ArrowRight" ? 1 : -1) / exportFps;
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
  }, [
    state.time,
    state.playing,
    state.ready,
    state.updating,
    exportFps,
    state.exporting,
  ]);
  async function startExport() {
    if (
      savingSettings ||
      state.updating ||
      state.exporting ||
      !exportResolution
    )
      return;
    const controller = new AbortController();
    abort.current = controller;
    audio.current?.stop();
    patch({
      playing: false,
      exporting: true,
      exportStage: "Preparing export…",
      done: 0,
      total: frameCount(project.duration, exportFps),
      error: "",
      result: "",
      download: "",
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
    const [width, height] = exportResolution.split("x").map(Number);
    try {
      const { exportMp4: exportVideo } =
        await import("../engine/export/formats/mp4/export-mp4");
      const result = await exportVideo(project, {
        width,
        height,
        fps: exportFps,
        bitrate: exportBitrate || undefined,
        latencyMode: exportLatencyMode,
        keyFrameInterval: exportKeyFrameInterval,
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
      a.download = filename;
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
  const unexpandSource = useCallback(
    () => dispatch({ type: "setSourceOpen", open: false }),
    [],
  );
  const { exportCollapsed, sourceCollapsed } = state;
  const setExportCollapsed = (exportCollapsed: boolean) =>
    patch({ exportCollapsed });
  const setSourceCollapsed = (sourceCollapsed: boolean) =>
    patch({ sourceCollapsed });

  const sceneSource = (
    <SceneSource
      scenes={project.scenes}
      sources={sources}
      activeId={active.id}
      pinnedId={state.pinnedSourceId}
      expanded={state.sourceOpen}
      collapsed={false}
      onToggleCollapse={unexpandSource}
      onUnexpand={unexpandSource}
      onPin={pinSource}
      onFollow={followSource}
    />
  );

  const renderExport = (collapsed: boolean, borderTop = false) => (
    <ExportPanel
      ready={state.ready && !state.updating && !savingSettings}
      savingSettings={savingSettings}
      exporting={state.exporting}
      stage={state.exportStage}
      resolution={exportResolution}
      sizes={sizes}
      aspectRatio={project.aspectRatio}
      fps={exportFps}
      bitrate={exportBitrate}
      latencyMode={exportLatencyMode}
      keyFrameInterval={exportKeyFrameInterval}
      onBitrate={(bitrate) =>
        void updateExportSettings({ bitrate: bitrate || "auto" })
      }
      onLatencyMode={(latencyMode) =>
        void updateExportSettings({ latencyMode })
      }
      onKeyFrameInterval={(keyFrameInterval) =>
        void updateExportSettings({ keyFrameInterval })
      }
      duration={project.duration}
      hasAudio={audibleAudioTracks(project).some((track) =>
        track.clips.some((clip) => !mutedClipIds.includes(clip.id)),
      )}
      done={state.done}
      total={state.total}
      result={state.result}
      download={state.download}
      filename={filename}
      collapsed={collapsed}
      borderTop={borderTop}
      onToggleCollapse={(next) => setExportCollapsed(next)}
      onResolution={(resolution) => {
        const [width, height] = resolution.split("x").map(Number);
        void updateExportSettings({ resolution: [width, height] });
      }}
      onFps={(fps) => void updateExportSettings({ fps: fps as 24 | 30 | 60 })}
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
          Scene source is open on the composition.{" "}
          <button
            type="button"
            className="text-primary hover:underline cursor-pointer"
            onClick={unexpandSource}
          >
            Choose Picture
          </button>{" "}
          to read it here again.
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
        onUnexpand={unexpandSource}
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
      <ErrorBanner error={state.error || settingsError} />
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
                  ready={state.ready && !state.updating && !state.exporting}
                  playing={state.playing}
                  time={state.time}
                  duration={project.duration}
                  fps={exportFps}
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
              fps={exportFps}
              time={state.time}
              playing={state.playing}
              zoom={state.tlZoom}
              scenes={project.scenes}
              audioTracks={project.audioTracks ?? []}
              activeSceneId={active.id}
              mutedTrackIds={mutedTrackIds}
              mutedClipIds={mutedClipIds}
              onZoom={(zoom) => dispatch({ type: "tlZoom", zoom })}
              onSeek={seekTo}
              onToggleMute={toggleTrackMute}
              onToggleClipMute={toggleClipMute}
              savingSettings={savingSettings}
              onOpenSource={pinSource}
            />
          }
        />
      </main>
      <StudioFooter />
    </div>
  );
}
