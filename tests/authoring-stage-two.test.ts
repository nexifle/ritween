import test from "node:test";
import assert from "node:assert/strict";
import {
  Circle,
  Line,
  Group,
  ForEach,
  HStack,
  Box,
  Image,
  Video,
  Motion,
  motion,
  evaluateView,
  World,
  Composition,
  Shot,
} from "../src/authoring/index";
import { videoResource } from "../src/engine/render/visual";
import { resolveMediaProject } from "../src/engine/media/project";
import { fitMedia } from "../src/authoring/media";
import { ViewMedia, mediaKey } from "../src/authoring/media-runtime";
import { collectSharedElements } from "../src/authoring/shared-elements";
import type { ViewNode } from "../src/authoring/nodes";
import type { SetupContext } from "../src/engine/types";
import type { ImageTexture, VideoTexture } from "../src/engine/render/visual";

const evaluate = (node: ViewNode, time = 0) =>
  evaluateView(node, { time, width: 200, height: 200, measureText: () => 0 });
const clip = videoResource({
  id: "footage",
  name: "Footage",
  url: "/source.mp4",
  start: 0,
  duration: 2,
  offset: 1,
});
const style = { width: 100, height: 100 };
const timing = (time: number) => ({
  time,
  localTime: time,
  progress: time / 2,
});

test("Circle trim/stroke and Line progress reuse inspectable path commands and stable layout", () => {
  const circle = Circle({
    radius: 40,
    fill: "red",
    stroke: "blue",
    strokeWidth: 8,
    trim: [0, Motion.fade({ duration: 1 })],
  }).id("badge");
  assert.equal(evaluate(circle).commands.length, 0);
  const frame = evaluate(circle, 1);
  assert.equal(frame.tree.kind, "circle");
  assert.equal(frame.commands.length, 2);
  assert.equal(collectSharedElements(frame, [200, 200], [200, 200]).length, 1);
  assert.deepEqual(frame.tree.bounds, { x: 0, y: 0, width: 80, height: 80 });
  const line = Line({
    from: [100, 0],
    to: [0, 50],
    width: 4,
    progress: Motion.fade({ duration: 1 }),
  });
  assert.equal(evaluate(line).commands.length, 0);
  assert.equal(evaluate(line, 1).commands.length, 1);
  assert.deepEqual(evaluate(line).tree.bounds, evaluate(line, 1).tree.bounds);
  assert.throws(() => evaluate(Circle({ radius: -1 })), /Circle/);
  assert.throws(
    () => evaluate(Circle({ radius: 10, trim: [0.8, 0.2] })),
    /trim/,
  );
  assert.throws(() => evaluate(Line({ from: [NaN, 0], to: [0, 0] })), /Line/);
});

test("Group overlays one slot, ForEach expands stable keyed siblings after modifiers", () => {
  const nodes = ForEach(
    [{ id: "b" }, { id: "a" }],
    (item) => item.id,
    () => Box({ width: 20, height: 10 }).padding(2),
  );
  const layout = evaluate(HStack(nodes, { gap: 5 }));
  assert.deepEqual(
    layout.tree.children.map((n) => n.path),
    ["root/b", "root/a"],
  );
  const group = evaluate(Group(nodes).opacity(0.5));
  assert.equal(group.tree.bounds.width, 24);
  assert.equal(group.commands.length, 1);
  const layer = group.commands[0];
  assert.equal(layer.kind, "group");
  assert.equal(layer.opacity, 0.5);
  if (layer.kind !== "group") return;
  assert.deepEqual(
    layer.frame.commands.map((c) => c.opacity),
    [1, 1],
  );
  assert.deepEqual(
    layer.frame.commands[0].bounds,
    layer.frame.commands[1].bounds,
  );
  assert.throws(
    () =>
      ForEach(
        [1, 2],
        () => "same",
        () => Box({ width: 1, height: 1 }),
      ),
    /unique/,
  );
  assert.ok(Object.isFrozen(nodes));
});

test("motion presets and stagger are immutable tracks using the existing evaluator", () => {
  const fade = Motion.fade({ delay: 0.2, duration: 0.6, ease: "linear" });
  const delayed = Motion.stagger(2, 0.1, fade);
  assert.equal(motion(delayed as never, 0.4), 0);
  assert.ok(Math.abs(motion(delayed as never, 0.7) - 0.5) < 1e-8);
  assert.equal(motion(Motion.slide(), 0), 32);
  assert.equal(motion(Motion.scale(), 1), 1);
  const keys = Motion.stagger(
    1,
    1,
    Motion.keyframes([
      { at: 0, value: 3 },
      { at: 1, value: 5 },
    ]),
  );
  assert.equal(motion(keys as never, 1), 3);
  assert.equal(motion(keys as never, 2), 5);
  assert.ok(Object.isFrozen(fade));
  assert.throws(() => Motion.stagger(-1, 0.1, fade), /Stagger/);
  assert.throws(() => Motion.fade({ duration: 0 }), /duration/);
});

test("media snapshots inputs, fits cover/contain, and keeps video on the project clock inside Worlds", () => {
  const mutable = { ...clip };
  const video = Video(mutable, style);
  mutable.offset = 99;
  const nested = Composition(
    World(() => video, { size: [100, 100] }),
    { rate: -2, offset: 20 },
  );
  const frame = evaluate(nested, 1);
  const command = frame.commands[0];
  assert.equal(command.kind, "composition");
  if (command.kind !== "composition") return;
  const media = command.frame.commands[0];
  assert.equal(media.kind, "media");
  if (media.kind !== "media" || media.source.kind !== "video") return;
  assert.equal(media.time, 1);
  assert.equal(media.source.clip.offset, 1);
  assert.equal(evaluate(video, 3).commands.length, 0);
  assert.deepEqual(fitMedia(100, 100, 200, 100, "contain"), {
    x: 0,
    y: 25,
    width: 100,
    height: 50,
    uv: [1, 1, 0, 0],
  });
  assert.deepEqual(fitMedia(100, 100, 200, 100, "cover").uv, [0.5, 1, 0.25, 0]);
  assert.throws(
    () => Image({ url: "/a.png", width: 0, height: 10 }),
    /dimensions/,
  );
});

test("Shot carries a single clip declaration into the existing footage audio resolver", () => {
  const shot = Shot({
    id: "shot",
    source: "fixture",
    start: 0,
    duration: 2,
    world: World(() => Video(clip, style), { size: [100, 100] }),
    mediaClips: [clip],
  });
  const project = resolveMediaProject({
    name: "Media",
    resolution: [100, 100],
    aspectRatio: [1, 1],
    duration: 2,
    scenes: [shot],
  });
  const audio = project.audioTracks![0].clips[0];
  assert.equal(audio.id, clip.id);
  assert.equal(audio.start, clip.start);
  assert.equal(audio.sceneId, shot.id);
  assert.equal(project.scenes[0].mediaClips, undefined);
});

function harness(activeOnly = true) {
  const events: string[] = [];
  const resources: (ImageTexture | VideoTexture)[] = [];
  const make = (name: string, video: boolean) => {
    const resource = {
      texture: {} as GPUTexture,
      width: 200,
      height: 100,
      dispose() {
        events.push(`dispose:${name}`);
      },
      ...(video
        ? {
            async prepareFrame({ time }: { time: number }) {
              events.push(`frame:${time}`);
            },
          }
        : {}),
    };
    resources.push(resource);
    return resource;
  };
  const runtime = new ViewMedia({} as SetupContext, [clip], activeOnly, {
    image: async () => {
      events.push("load:image");
      return make("image", false);
    },
    video: async () => {
      events.push("load:video");
      return make("video", true) as VideoTexture;
    },
  });
  return { runtime, events, resources };
}

test("media runtime deduplicates resources, seeks deterministically and releases inactive videos", async () => {
  const { runtime, events } = harness();
  const node = Group([Video(clip, style), Video(clip, style).offset(10)]);
  await runtime.setup(evaluate(node));
  assert.deepEqual(events, []);
  for (const time of [1, 0.5, 1])
    await runtime.prepare(evaluate(node, time), timing(time));
  assert.deepEqual(events, ["load:video", "frame:1", "frame:0.5", "frame:1"]);
  await runtime.prepare(evaluate(Box({ width: 1, height: 1 })), timing(1));
  assert.equal(events.at(-1), "dispose:video");
  await runtime.prepare(evaluate(node, 1), timing(1));
  runtime.dispose();
  runtime.dispose();
  assert.equal(events.filter((e) => e === "dispose:video").length, 2);
});

test("eager media setup owns clips; missing declarations and partial setup failures are explicit", async () => {
  const { runtime, events } = harness(false);
  await runtime.setup(evaluate(Video(clip, style)));
  assert.deepEqual(events, ["load:video"]);
  runtime.dispose();
  const missing = new ViewMedia({} as SetupContext, [], true);
  await assert.rejects(
    missing.setup(evaluate(Video(clip, style))),
    /must use a clip declared/,
  );
  const failure = new ViewMedia({} as SetupContext, [clip], false, {
    image: async () => ({
      texture: {} as GPUTexture,
      width: 1,
      height: 1,
      dispose() {
        events.push("clean:image");
      },
    }),
    video: async () => {
      throw Error("decode failed");
    },
  });
  await assert.rejects(
    failure.setup(
      evaluate(
        Group([Image({ url: "/image.png", ...style }), Video(clip, style)]),
      ),
    ),
    /decode failed/,
  );
  assert.equal(events.at(-1), "clean:image");
});

test("media preparation preserves cancellation identity and rejects disposed/aborted calls", async () => {
  const { runtime } = harness();
  const controller = new AbortController();
  const reason = new DOMException("Superseded", "AbortError");
  controller.abort(reason);
  await assert.rejects(
    runtime.prepare(evaluate(Video(clip, style)), {
      ...timing(0),
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  runtime.dispose();
  await assert.rejects(runtime.prepare(evaluate(Group([])), timing(0)), {
    name: "AbortError",
  });
});

test("media completing after deactivate/dispose is released instead of published", async () => {
  for (const dispose of [false, true]) {
    let finish!: (value: VideoTexture) => void;
    let loaded!: () => void;
    const started = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    let released = 0;
    const runtime = new ViewMedia({} as SetupContext, [clip], true, {
      image: async () => {
        throw Error("unexpected image");
      },
      video: async () => {
        loaded();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const frame = evaluate(Video(clip, style), 1);
    const preparing = runtime.prepare(frame, timing(1));
    await started;
    if (dispose) runtime.dispose();
    else runtime.deactivate();
    finish({
      texture: {} as GPUTexture,
      width: 1,
      height: 1,
      async prepareFrame() {},
      dispose() {
        released++;
      },
    });
    await assert.rejects(preparing);
    assert.equal(released, 1);
    assert.equal(
      runtime.resources.has(
        mediaKey(
          (
            frame.commands[0] as Extract<
              (typeof frame.commands)[number],
              { kind: "media" }
            >
          ).source,
        ),
      ),
      false,
    );
  }
});
