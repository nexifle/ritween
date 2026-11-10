import assert from "node:assert/strict";
import { test } from "node:test";
import {
  World,
  Shot,
  Composition,
  Box,
  Text,
  ZStack,
  evaluateView,
  Camera,
} from "../src/authoring/index";
import {
  evaluate,
  evaluateActive,
  validateProject,
} from "../src/engine/timeline";
import type { Project, SceneEntry, Transition } from "../src/engine/types";

const world = World(
  ({ localTime }) => Box({ width: 20 + localTime, height: 20 }),
  { size: [400, 300] },
);
const frame = (time: number) =>
  evaluateView(
    Composition(world, {
      size: [200, 100],
      offset: 3,
      rate: 2,
      camera: Camera({ zoom: 2 }),
      overlay: () => Text("HUD"),
    }),
    { time, width: 400, height: 300, measureText: (s) => s.length * 10 },
  );
function entry(
  id: string,
  start: number,
  duration: number,
  transition: Transition = { type: "cut" },
): SceneEntry {
  return Shot({
    id,
    start,
    duration,
    source: "manifest.ts",
    world,
    transition,
  });
}
function project(scenes: SceneEntry[]): Project {
  return {
    name: "Composition",
    resolution: [400, 300],
    aspectRatio: [4, 3],
    duration: scenes.at(-1)!.start + scenes.at(-1)!.duration,
    scenes,
  };
}

test("World is immutable reusable content; Shot creates independent scene resources", () => {
  assert.ok(Object.isFrozen(world));
  assert.ok(Object.isFrozen(world.size));
  const a = entry("a", 0, 3),
    b = entry("b", 3, 3);
  const first = a.create(),
    second = b.create();
  assert.notEqual(first, second);
  first.dispose();
  second.dispose();
  assert.throws(() =>
    World(() => Box({ width: 1, height: 1 }), { size: [0, 300] }),
  );
  assert.throws(() => entry("", 0, 1));
});

test("composition separates viewport, world clock, camera and overlay", () => {
  const result = frame(2),
    command = result.commands[0];
  assert.equal(command.kind, "composition");
  if (command.kind !== "composition") return;
  assert.equal(command.bounds.width, 200);
  assert.equal(command.frame.commands[0].bounds.width, 27);
  assert.equal(command.frame.camera!.zoom, 2);
  assert.equal(command.overlay!.camera, undefined);
  assert.equal(command.overlay!.commands[0].kind, "text");
  const expected = frame(2);
  frame(5);
  frame(0);
  assert.deepEqual(frame(2), expected);
});

test("nested compositions preserve local viewports and inherited/overridden themes", () => {
  const child = World(
    ({ theme, designSize }) => Text(`${theme.font}:${designSize[0]}`),
    { size: [80, 50] },
  );
  const parent = World(() => ZStack([Composition(child).offset(10, 20)]), {
    size: [400, 300],
  });
  const root = Composition(parent, {
    theme: { font: "Test", textColor: "#FF0000", colors: {} },
  });
  const evaluated = evaluateView(root, {
    time: 1,
    width: 400,
    height: 300,
    measureText: () => 20,
  });
  const outer = evaluated.commands[0];
  assert.equal(outer.kind, "composition");
  if (outer.kind !== "composition") return;
  const nested = outer.frame.commands[0];
  assert.equal(nested.kind, "composition");
  if (nested.kind !== "composition") return;
  const text = nested.frame.commands[0];
  assert.equal(text.kind, "text");
  if (text.kind !== "text") return;
  assert.deepEqual(nested.transform, [1, 1, 10, 20]);
  assert.deepEqual(text.text.lines, ["Test:80"]);
  assert.equal(text.text.color, "#FF0000");
});

test("recursive composition references fail with bounded recursion", () => {
  const recursive = World(() => Composition(recursive), { size: [100, 100] });
  assert.throws(
    () =>
      evaluateView(Composition(recursive), {
        time: 0,
        width: 100,
        height: 100,
        measureText: () => 0,
      }),
    /nesting exceeds 32/,
  );
});

test("incoming transitions define exact overlaps and both local clocks at boundaries", () => {
  const p = project([
    entry("a", 0, 5),
    entry("b", 4, 5, { type: "crossfade", duration: 1 }),
  ]);
  validateProject(p);
  assert.equal(evaluateActive(p, 3.999).active.length, 1);
  const start = evaluateActive(p, 4);
  assert.deepEqual(
    start.active.map((a) => a.localTime),
    [4, 0],
  );
  assert.equal(start.transition!.progress, 0);
  assert.equal(evaluate(p, 4).entry.id, "b");
  const midpoint = evaluateActive(p, 4.5);
  assert.deepEqual(
    midpoint.active.map((a) => a.localTime),
    [4.5, 0.5],
  );
  assert.equal(midpoint.transition!.progress, 0.5);
  assert.equal(evaluateActive(p, 5).active.length, 1);
  assert.equal(evaluateActive(p, 9).primary.progress, 1);
  assert.equal(evaluateActive(p, 90).active.length, 1);
});

test("overlap validation rejects gaps, cut overlaps, invalid effects and triple overlaps", () => {
  const first = entry("a", 0, 5);
  for (const next of [
    entry("b", 4, 5),
    entry("b", 6, 5),
    entry("b", 4, 5, { type: "crossfade", duration: 0 }),
    entry("b", 4, 5, { type: "crossfade", duration: 2 }),
    entry("b", 0, 5, { type: "crossfade", duration: 5 }),
  ])
    assert.throws(() => validateProject(project([first, next])));
  assert.throws(() =>
    validateProject(project([entry("a", 0, 5, { type: "wipe", duration: 1 })])),
  );
  assert.throws(() =>
    validateProject(
      project([
        first,
        entry("b", 3, 5, { type: "crossfade", duration: 2 }),
        entry("c", 4, 6, { type: "slide", duration: 4 }),
      ]),
    ),
  );
  for (const type of ["crossfade", "wipe", "slide", "zoom"] as const)
    validateProject(project([first, entry("b", 4, 5, { type, duration: 1 })]));
});
