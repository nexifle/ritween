import { Icon } from "./icon";

export function StudioFooter() {
  return (
    <footer className="flex shrink-0 flex-wrap justify-between gap-x-3 gap-y-1 border-t border-rule px-4 py-1.5 text-[11px] text-footer">
      <span className="flex items-center gap-1.5">
        <Icon name="check" size={13} /> Deterministic rendering · Same engine,
        every frame
      </span>
      <span>
        Space plays · ← → step · scroll picture to zoom, drag to pan · timeline
        scroll pans, ⌘/Ctrl-scroll zooms · drag dividers to resize, double-click
        a divider to reset
      </span>
    </footer>
  );
}
