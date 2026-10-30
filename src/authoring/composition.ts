import type { SceneEntry, Transition } from "../engine/types";
import { ViewNode } from "./nodes";
import { type StageContext, type StageOptions } from "./stage";
import { StageEntry, type StageEntryOptions } from "./stage-entry";
import { Camera, type Point2D } from "./camera";
import type { Theme } from "./layout";

export interface WorldOptions {
  readonly size: Point2D;
}
export interface WorldDefinition {
  readonly size: Point2D;
  readonly view: (context: StageContext) => ViewNode;
}
/** Reusable pure content, never a shared Scene/GPU instance. */
export function World(
  view: (context: StageContext) => ViewNode,
  options: WorldOptions,
): WorldDefinition {
  if (
    options.size.length !== 2 ||
    !options.size.every((n) => Number.isFinite(n) && n > 0)
  )
    throw Error("World size must have two positive finite dimensions.");
  return Object.freeze({
    view,
    size: Object.freeze([...options.size]) as Point2D,
  });
}
export interface CompositionOptions {
  /** Viewport/layout size; defaults to world size. */
  readonly size?: Point2D;
  readonly camera?: StageOptions["camera"];
  readonly theme?: Theme;
  /** World clock = parent localTime * rate + offset. Camera/overlay use parent time. */
  readonly offset?: number;
  readonly rate?: number;
  /** Viewport-space content: unaffected by this composition's camera. */
  readonly overlay?: (context: StageContext) => ViewNode;
}
export interface CompositionSpec {
  readonly kind: "composition";
  readonly world: WorldDefinition;
  readonly options: CompositionOptions;
}
/** Embed a world as a clipped viewport; modifiers place it like any other node. */
export function Composition(
  world: WorldDefinition,
  options: CompositionOptions = {},
): ViewNode {
  const size = options.size ?? world.size;
  if (
    size.length !== 2 ||
    !size.every((n) => Number.isFinite(n) && n > 0) ||
    ![options.offset ?? 0, options.rate ?? 1].every(Number.isFinite)
  )
    throw Error(
      "Composition needs a positive viewport and finite clock mapping.",
    );
  return new ViewNode({
    kind: "composition",
    world,
    options: Object.freeze({
      ...options,
      size: Object.freeze([...size]) as Point2D,
      theme: options.theme
        ? Object.freeze({
            ...options.theme,
            colors: Object.freeze({ ...options.theme.colors }),
          })
        : undefined,
      camera:
        typeof options.camera === "function"
          ? options.camera
          : options.camera
            ? Camera(options.camera)
            : undefined,
    }),
  });
}
export interface ShotOptions extends Omit<StageEntryOptions, "view"> {
  readonly world: WorldDefinition;
  readonly camera?: StageOptions["camera"];
  readonly worldOffset?: number;
  readonly worldRate?: number;
  readonly overlay?: (context: StageContext) => ViewNode;
  readonly transition?: Transition;
}
/** A timeline entry viewing reusable content; each create() owns independent resources. */
export function Shot(options: ShotOptions): SceneEntry {
  const {
    id,
    name = id,
    source,
    start,
    duration,
    world,
    camera,
    overlay,
    worldOffset,
    worldRate,
    transition = { type: "cut" },
    ...stageOptions
  } = options;
  const projection =
    typeof camera === "function" ? camera : camera ? Camera(camera) : undefined;
  return StageEntry({
    ...stageOptions,
    id,
    name,
    source,
    start,
    duration,
    transition,
    view: ({ designSize }) =>
      Composition(world, {
        size: designSize,
        camera: projection,
        overlay,
        offset: worldOffset,
        rate: worldRate,
      }),
  });
}
