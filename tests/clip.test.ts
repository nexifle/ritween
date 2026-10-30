import test from "node:test";
import assert from "node:assert/strict";
import { Box, Video, evaluateView } from "../src/authoring/index";
const evaluate = (node: ReturnType<typeof Box>) =>
  evaluateView(node, {
    time: 1,
    width: 200,
    height: 200,
    measureText: () => 0,
  });
test("clip isolates content within layout bounds without changing layout", () => {
  const node = Box({ width: 150, height: 150 })
    .frame({ width: 100, height: 80 })
    .clip({ shape: "circle" })
    .offset(20, 30);
  const frame = evaluate(node);
  assert.equal(frame.tree.bounds.width, 100);
  const command = frame.commands[0];
  assert.equal(command.kind, "composition");
  if (command.kind !== "composition") return;
  assert.equal(command.bounds.width, 100);
  assert.ok(command.mask?.length);
  assert.deepEqual(command.transform, [1, 1, 20, 30]);
  assert.equal(command.frame.commands[0].bounds.width, 150);
  assert.deepEqual(evaluate(node), frame);
  assert.throws(
    () => Box({ width: 1, height: 1 }).clip({ shape: "rect", radius: -1 }),
    /radius/,
  );
});
test("image masks are snapshotted and discovered as media without changing layout", () => {
  const shape = {
    shape: "image" as const,
    url: "/mask.png",
    mode: "luminance" as const,
  };
  const node = Box({ width: 80, height: 40 }).clip(shape);
  shape.url = "/changed.png";
  const frame = evaluate(node);
  assert.equal(frame.tree.bounds.width, 80);
  const command = frame.commands[0];
  assert.equal(command.kind, "composition");
  if (command.kind !== "composition") return;
  assert.equal(command.imageMask?.url, "/mask.png");
  assert.equal(command.imageMask?.mode, "luminance");
  assert.equal(command.mask, undefined);
  assert.throws(
    () => Box({ width: 1, height: 1 }).clip({ shape: "image", url: " " }),
    /URL/,
  );
  assert.throws(
    () =>
      Box({ width: 1, height: 1 }).clip({
        shape: "image",
        url: "/a.png",
        mode: "multiply" as never,
      }),
    /alpha or luminance/,
  );
});

test("crop tracks are snapshotted and evaluated in local time", () => {
  const zoom = { from: 1, to: 2, duration: 1 };
  const node = Video(
    { id: "v", name: "v", url: "/v.mp4", start: 0, duration: 2 },
    { width: 100, height: 100, crop: { x: 0.8, zoom } },
  );
  zoom.to = 99;
  const command = evaluate(node).commands[0];
  assert.equal(command.kind, "media");
  if (command.kind === "media") assert.deepEqual(command.crop, [0.8, 0.5, 2]);
});
