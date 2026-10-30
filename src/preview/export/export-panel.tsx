import { useEffect, useId, useRef, useState } from "react";
import type { ExportJob } from "../../engine/export/job";
import { ExportHelp } from "./export-help";
import { SidebarPanel } from "../components/sidebar-panel";
import { ExportFiles } from "./export-files";
import { ExportSettings, type ExportSettingsProps } from "./export-settings";
import { ExportStatus } from "./export-status";

interface ExportPanelProps extends Omit<ExportSettingsProps, "disabled"> {
  ready: boolean;
  exporting: boolean;
  savingSettings?: boolean;
  job?: ExportJob;
  jobs: readonly ExportJob[];
  connected: boolean;
  onDelete: (id: string) => void;
  onCancelJob: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: (collapsed: boolean) => void;
  onExport: () => void;
  onCancel: () => void;
  borderTop?: boolean;
  onPreferredHeight?: (height: number | undefined) => void;
}

export function ExportPanel({
  ready,
  exporting,
  savingSettings,
  job,
  jobs,
  connected,
  onDelete,
  onCancelJob,
  collapsed,
  onToggleCollapse,
  onExport,
  onCancel,
  borderTop,
  onPreferredHeight,
  ...settings
}: ExportPanelProps) {
  const [tab, setTab] = useState<"settings" | "exports">("settings");
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const tabs = ["settings", "exports"] as const;
  useEffect(() => {
    if (collapsed) return;
    if (tab !== "settings") {
      onPreferredHeight?.(undefined);
      return;
    }
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const panel = element.closest("section");
      const header = panel?.firstElementChild;
      const tabs = panel?.querySelector('[role="tablist"]');
      onPreferredHeight?.(
        Math.ceil(
          element.getBoundingClientRect().height +
            (header?.getBoundingClientRect().height ?? 0) +
            (tabs?.getBoundingClientRect().height ?? 0),
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [collapsed, tab, onPreferredHeight]);
  return (
    <SidebarPanel
      icon="export"
      title="Export video"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      borderTop={borderTop}
      contentClassName="flex flex-col overflow-y-hidden"
      actions={<ExportHelp />}
    >
      <div
        role="tablist"
        aria-label="Export views"
        className="flex h-8 shrink-0 gap-4 border-b border-separator px-3"
        onKeyDown={(event) => {
          const index = tabs.indexOf(tab);
          const next =
            event.key === "Home"
              ? "settings"
              : event.key === "End"
                ? "exports"
                : event.key === "ArrowRight" || event.key === "ArrowLeft"
                  ? tabs[(index + 1) % 2]
                  : undefined;
          if (!next) return;
          event.preventDefault();
          setTab(next);
          event.currentTarget
            .querySelector<HTMLButtonElement>(
              `#${CSS.escape(`${id}-${next}-tab`)}`,
            )
            ?.focus();
        }}
      >
        {tabs.map((value) => (
          <button
            key={value}
            id={`${id}-${value}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${id}-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            className={`relative flex items-center gap-1.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${tab === value ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-primary" : "text-meta hover:text-foreground"}`}
          >
            {value === "settings" ? "Settings" : "Exports"}
            {value === "exports" && jobs.length > 0 && (
              <span className="rounded-[3px] bg-secondary px-1.5 text-[10px] tabular-nums text-meta">
                {jobs.length}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        id={`${id}-settings-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-settings-tab`}
        hidden={tab !== "settings"}
        className={
          tab === "settings" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"
        }
      >
        <div ref={content}>
          <div className="px-3 py-3">
            <ExportSettings
              {...settings}
              disabled={exporting || !!savingSettings}
            />
          </div>
          <div className="sticky bottom-0 border-t border-separator bg-card px-3 py-2.5">
            {(!connected || savingSettings) && (
              <p role="status" className="mb-2 text-[10px] text-meta">
                {!connected
                  ? "Reconnecting… Exports continue on the server."
                  : "Saving settings…"}
              </p>
            )}
            <ExportStatus
              job={job}
              exporting={exporting}
              ready={ready && !!settings.resolution}
              onExport={onExport}
              onCancel={onCancel}
            />
          </div>
        </div>
      </div>
      <div
        id={`${id}-exports-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-exports-tab`}
        hidden={tab !== "exports"}
        className={
          tab === "exports" ? "flex min-h-0 flex-1 flex-col" : "hidden"
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ExportFiles jobs={jobs} onDelete={onDelete} onCancel={onCancelJob} />
        </div>
        <p className="shrink-0 border-t border-separator px-3 py-2 text-[10px] text-meta">
          Download files before stopping the server.
        </p>
      </div>
    </SidebarPanel>
  );
}
