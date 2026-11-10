export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out";
export interface Tween {
  readonly from: number;
  readonly to: number;
  readonly duration: number;
  readonly delay?: number;
  readonly ease?: Easing;
}
export interface Keyframe {
  readonly at: number;
  readonly value: number;
  /** Easing from the previous keyframe into this one. */
  readonly ease?: Easing;
}
export interface Keyframes {
  readonly keyframes: readonly Keyframe[];
}
export type AnimatedNumber = number | Tween | Keyframes;
export type MotionOptions = Partial<
  Pick<Tween, "from" | "to" | "duration" | "delay" | "ease">
>;
function preset(options: MotionOptions, from: number, to: number): Tween {
  const value = Object.freeze({
    from,
    to,
    duration: 0.6,
    ease: "ease-out" as const,
    ...options,
  });
  motion(value, 0);
  return value;
}
/** Shift a numeric track without introducing a second animation clock. */
export function stagger(
  index: number,
  interval: number,
  value: AnimatedNumber,
): AnimatedNumber {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isFinite(interval) ||
    interval < 0
  )
    throw Error(
      "Stagger needs a non-negative integer index and finite non-negative interval.",
    );
  const delay = index * interval;
  if (!Number.isFinite(delay)) throw Error("Stagger delay must be finite.");
  if (typeof value === "number") return resolveNumber(value, 0);
  if ("keyframes" in value)
    return keyframes(
      value.keyframes.map((frame) => ({ ...frame, at: frame.at + delay })),
    );
  const result = { ...value, delay: (value.delay ?? 0) + delay };
  motion(result, 0);
  return Object.freeze(result);
}
/** Data presets compose with existing opacity/offset/scale modifiers. */
export const Motion = Object.freeze({
  fade: (options: MotionOptions = {}) => preset(options, 0, 1),
  slide: (options: MotionOptions = {}) => preset(options, 32, 0),
  scale: (options: MotionOptions = {}) => preset(options, 0.9, 1),
  stagger,
  keyframes,
});

function easing(ease: Easing, t: number): number {
  switch (ease) {
    case "linear":
      return t;
    case "ease-in":
      return t * t * t;
    case "ease-out":
      return 1 - (1 - t) ** 3;
    case "ease-in-out":
      return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    default:
      throw Error(`Unknown easing: ${ease}`);
  }
}
function validateFrames(frames: readonly Keyframe[]): void {
  if (!frames.length) throw Error("Keyframes must not be empty.");
  frames.forEach((frame, i) => {
    if (
      !Number.isFinite(frame.at) ||
      !Number.isFinite(frame.value) ||
      (i > 0 && frame.at <= frames[i - 1].at)
    )
      throw Error(
        "Keyframes need finite values and strictly increasing times.",
      );
    easing(frame.ease ?? "ease-out", 0);
  });
}
/** Scene-local seconds; values clamp outside the track. Easing belongs to the destination. */
export function keyframes(frames: readonly Keyframe[]): Keyframes {
  validateFrames(frames);
  return Object.freeze({
    keyframes: Object.freeze(
      frames.map((frame) => Object.freeze({ ...frame })),
    ),
  });
}
/** Snapshot descriptors so mutable caller data cannot change an immutable node/camera. */
export function snapshotNumber(value: AnimatedNumber): AnimatedNumber {
  if (typeof value === "number") return value;
  return "keyframes" in value
    ? keyframes(value.keyframes)
    : Object.freeze({ ...value });
}
/** Pure evaluation; never advances a clock or depends on the previous frame. */
export function motion(value: Tween | Keyframes, time: number): number {
  if (!Number.isFinite(time)) throw Error("Motion time must be finite.");
  if ("keyframes" in value) {
    const frames = value.keyframes;
    validateFrames(frames);
    if (time <= frames[0].at) return frames[0].value;
    for (let i = 1; i < frames.length; i++) {
      const next = frames[i],
        previous = frames[i - 1];
      if (time <= next.at)
        return motion(
          {
            from: previous.value,
            to: next.value,
            duration: next.at - previous.at,
            delay: previous.at,
            ease: next.ease,
          },
          time,
        );
    }
    return frames[frames.length - 1].value;
  }
  const { from, to, duration, delay = 0, ease = "ease-out" } = value;
  if (![from, to, duration, delay].every(Number.isFinite) || duration <= 0)
    throw Error("Motion needs finite values and a positive duration.");
  const t = Math.max(0, Math.min(1, (time - delay) / duration));
  const result = from + (to - from) * easing(ease, t);
  if (!Number.isFinite(result)) throw Error("Motion result must be finite.");
  return result;
}
export function resolveNumber(value: AnimatedNumber, time: number): number {
  const result = typeof value === "number" ? value : motion(value, time);
  if (!Number.isFinite(result)) throw Error("Expected a finite number.");
  return result;
}
