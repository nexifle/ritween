"use client";

import { cn } from "cn";
import type { ComponentProps } from "react";
import * as ResizablePrimitive from "react-resizable-panels";

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "group relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-transparent ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 focus-visible:outline-hidden aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-3 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors duration-200 ease-out group-hover:bg-muted-foreground/45 group-data-[separator=active]:bg-primary/50 group-aria-[orientation=horizontal]:inset-x-0 group-aria-[orientation=horizontal]:inset-y-auto group-aria-[orientation=horizontal]:top-1/2 group-aria-[orientation=horizontal]:h-px group-aria-[orientation=horizontal]:w-full group-aria-[orientation=horizontal]:translate-x-0 group-aria-[orientation=horizontal]:-translate-y-1/2" />
      {withHandle && (
        <div className="z-10 flex h-4 w-0.5 shrink-0 rounded-full bg-muted-foreground/30 transition-colors duration-200 ease-out group-hover:bg-muted-foreground/60 group-data-[separator=active]:bg-primary/70" />
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };

export const dockPaneStyle = {
  overflow: "hidden",
  position: "relative",
} as const satisfies ComponentProps<typeof ResizablePanel>["style"];
