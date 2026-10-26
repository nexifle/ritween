import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  PlayIcon,
  PauseIcon,
  PreviousIcon,
  NextIcon,
  RotateCcwIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
  VolumeLowIcon,
  Download01Icon,
  SourceCodeIcon,
  CheckmarkCircle02Icon,
  Sun01Icon,
  Moon02Icon,
  Film01Icon,
} from "@hugeicons/core-free-icons";

export const icons: Record<string, IconSvgElement> = {
  play: PlayIcon,
  pause: PauseIcon,
  restart: RotateCcwIcon,
  back: PreviousIcon,
  next: NextIcon,
  "volume-high": VolumeHighIcon,
  "volume-low": VolumeLowIcon,
  "volume-mute": VolumeMute01Icon,
  export: Download01Icon,
  code: SourceCodeIcon,
  check: CheckmarkCircle02Icon,
  sun: Sun01Icon,
  moon: Moon02Icon,
  film: Film01Icon,
};

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  className,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const icon = icons[name];
  if (!icon) return null;

  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden="true"
    />
  );
}
