import test from "node:test";
import assert from "node:assert/strict";
import { Stage, StageEntry, Shot, World, Text } from "../src/authoring";
import type { SetupContext } from "../src/engine/types";

test("public setup failures clean faces and entries snapshot fonts before create", async () => {
  const originals = ["document", "FontFace"].map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  const faces = new Set<unknown>();
  const sources: string[] = [];
  class Face {
    constructor(_family: string, source: string) {
      sources.push(source);
    }
    async load() {
      return this;
    }
  }
  Object.defineProperty(globalThis, "FontFace", {
    configurable: true,
    value: Face,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      fonts: {
        add: (face: unknown) => faces.add(face),
        delete: (face: unknown) => faces.delete(face),
      },
    },
  });
  const context = { resolution: [100, 100] } as unknown as SetupContext;
  try {
    for (const [view, options, message] of [
      [
        () => {
          throw Error("view failed");
        },
        {},
        /view failed/,
      ],
      [() => Text("x"), { designSize: [0, 100] }, /design size/],
      [() => Text("x", { size: 0 }), {}, /positive/],
    ] as const) {
      const scene = Stage(view, {
        ...options,
        fonts: [{ family: "Lifecycle", source: "original" }],
      });
      await assert.rejects(scene.setup(context), message);
      assert.equal(faces.size, 0);
      await assert.rejects(scene.setup(context), /already/);
      scene.dispose?.();
      scene.dispose?.();
    }
    for (const kind of ["entry", "shot"]) {
      const descriptor = { family: "Snapshot", source: "original" };
      const fonts = [descriptor];
      const options = {
        id: kind,
        source: "fixture",
        start: 0,
        duration: 1,
        fonts,
      };
      const fail = () => {
        throw Error("snapshot probe");
      };
      const entry =
        kind === "entry"
          ? StageEntry({ ...options, view: fail })
          : Shot({ ...options, world: World(fail, { size: [100, 100] }) });
      descriptor.source = "mutated";
      fonts.push({ family: "Extra", source: "extra" });
      assert.equal(options.fonts, fonts);
      assert.equal(options.fonts[0], descriptor);
      const before = sources.length;
      const scene = entry.create();
      await assert.rejects(scene.setup(context), /snapshot probe/);
      assert.deepEqual(sources.slice(before), ['url("original")']);
      assert.equal(faces.size, 0);
      scene.dispose?.();
    }
  } finally {
    ["document", "FontFace"].forEach((key, i) => {
      const descriptor = originals[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
