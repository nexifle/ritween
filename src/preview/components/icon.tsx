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
  PlusSignIcon,
  MinusSignIcon,
  ZoomInIcon,
  ZoomOutIcon,
  FitToScreenIcon,
  Image01Icon,
  AspectRatioIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Copy01Icon,
  LocateIcon,
  Cancel01Icon,
  StopIcon,
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
  plus: PlusSignIcon,
  minus: MinusSignIcon,
  "zoom-in": ZoomInIcon,
  "zoom-out": ZoomOutIcon,
  fit: FitToScreenIcon,
  image: Image01Icon,
  "aspect-ratio": AspectRatioIcon,
  "chevron-down": ChevronDownIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-up": ChevronUpIcon,
  expand: ArrowExpand01Icon,
  unexpand: ArrowShrink01Icon,
  shrink: ArrowShrink01Icon,
  copy: Copy01Icon,
  follow: LocateIcon,
  locate: LocateIcon,
  cancel: Cancel01Icon,
  stop: StopIcon,
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
