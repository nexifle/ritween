import type { ReactNode } from "react";
import { usePersistentLayout } from "../hooks/use-persistent-layout";
import {
  dockPaneStyle,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/resizable";
import { useMediaQuery } from "../hooks/use-media-query";

function Fill({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-card">
      {children}
    </div>
  );
}

export function StudioDock({
  viewer,
  inspector,
  timeline,
}: {
  viewer: ReactNode;
  inspector: ReactNode;
  timeline: ReactNode;
}) {
  const stacked = useMediaQuery("(max-width: 1023px)");
  const stack = usePersistentLayout("ritween-stack", [
    "viewer",
    "inspector",
    "timeline",
  ]);
  const rows = usePersistentLayout("ritween-rows", ["stage", "timeline"]);
  const columns = usePersistentLayout("ritween-columns", [
    "viewer",
    "inspector",
  ]);

  if (stacked) {
    return (
      <ResizablePanelGroup
        id="ritween-stack"
        orientation="vertical"
        defaultLayout={stack.defaultLayout}
        onLayoutChanged={stack.onLayoutChanged}
      >
        <ResizablePanel
          id="viewer"
          defaultSize="54%"
          minSize="24%"
          style={dockPaneStyle}
        >
          <Fill>{viewer}</Fill>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="inspector"
          defaultSize="24%"
          minSize="16%"
          style={dockPaneStyle}
        >
          <Fill>{inspector}</Fill>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="timeline"
          defaultSize="22%"
          minSize="16%"
          style={dockPaneStyle}
        >
          <Fill>{timeline}</Fill>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <ResizablePanelGroup
      id="ritween-rows"
      orientation="vertical"
      defaultLayout={rows.defaultLayout}
      onLayoutChanged={rows.onLayoutChanged}
    >
      <ResizablePanel
        id="stage"
        defaultSize="78%"
        minSize="42%"
        style={dockPaneStyle}
      >
        <Fill>
          <ResizablePanelGroup
            id="ritween-columns"
            className="min-h-0 flex-1"
            orientation="horizontal"
            defaultLayout={columns.defaultLayout}
            onLayoutChanged={columns.onLayoutChanged}
          >
            <ResizablePanel
              id="viewer"
              defaultSize="74%"
              minSize="34%"
              style={dockPaneStyle}
            >
              <Fill>{viewer}</Fill>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="inspector"
              defaultSize="26%"
              minSize="16%"
              maxSize="42%"
              style={dockPaneStyle}
            >
              <Fill>{inspector}</Fill>
            </ResizablePanel>
          </ResizablePanelGroup>
        </Fill>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id="timeline"
        defaultSize="22%"
        minSize="16%"
        style={dockPaneStyle}
      >
        <Fill>{timeline}</Fill>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
