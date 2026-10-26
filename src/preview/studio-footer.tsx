import { Icon } from "./icon";

export function StudioFooter() {
  return (
    <footer className="mt-2 flex flex-wrap justify-between gap-1.5 text-[11px] text-footer">
      <span className="flex items-center gap-1.5">
        <Icon name="check" size={13} /> Deterministic rendering · Same
        engine, every frame
      </span>
      <span>
        Space plays · ← → step · scroll picture to zoom, drag to pan ·
        timeline scroll pans, ⌘/Ctrl-scroll zooms
      </span>
    </footer>
  );
}
