import test from "node:test";
import assert from "node:assert/strict";
import { StageFonts, snapshotFonts } from "../src/authoring/fonts";

test("font options snapshot and validate without retaining mutable inputs", () => {
  const input = [{ family: "Fixture", source: "/font.woff2" }];
  const result = snapshotFonts(input);
  input[0].family = "Changed";
  assert.equal(result[0].family, "Fixture");
  assert.ok(Object.isFrozen(result[0]));
  assert.throws(() => snapshotFonts([{ family: " ", source: "x" }]));
  assert.throws(() => snapshotFonts([{ family: "X", source: "" }]));
  assert.throws(
    () => snapshotFonts([{ family: "X", source: "a", style: "italic" }]),
    /normal style/,
  );
  assert.throws(
    () => snapshotFonts([{ family: "X", source: "a", weight: "bold" }]),
    /weight/,
  );
});

test("font ownership, delayed disposal and failure cannot leave registrations", async () => {
  const oldFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const registered = new Set();
  let release: (() => void) | undefined;
  class Face {
    constructor(readonly family: string) {}
    async load() {
      if (this.family === "delayed")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (this.family === "broken") throw Error("decode failed");
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
        add: (face: unknown) => registered.add(face),
        delete: (face: unknown) => registered.delete(face),
      },
    },
  });
  try {
    const a = new StageFonts(),
      b = new StageFonts();
    await a.load([{ family: "shared", source: "a" }]);
    await b.load([{ family: "shared", source: "a" }]);
    assert.equal(registered.size, 2);
    const conflict = new StageFonts();
    await assert.rejects(
      conflict.load([{ family: "SHARED", source: "different" }]),
      /Conflicting/,
    );
    assert.equal(registered.size, 2);
    for (const source of ["a", "different"]) {
      await assert.rejects(new StageFonts().load([
        { family: "shared", source, weight: "700" },
      ]), /Conflicting/);
      assert.equal(registered.size, 2);
    }
    a.dispose();
    a.dispose();
    assert.equal(registered.size, 1);
    b.dispose();
    const multi = new StageFonts(), multiOwner = new StageFonts();
    const configuration = [
      { family: "shared", source: "a", weight: "400" },
      { family: "shared", source: "b", weight: "700" },
    ];
    await multi.load(configuration);
    await multiOwner.load([...configuration].reverse());
    multi.dispose();
    await assert.rejects(new StageFonts().load([configuration[0]]), /Conflicting/);
    multiOwner.dispose();
    assert.equal(registered.size, 0);
    const delayed = new StageFonts();
    const pending = delayed.load([{ family: "delayed", source: "a" }]);
    delayed.dispose();
    release!();
    await assert.rejects(pending, /disposed/);
    assert.equal(registered.size, 0);
    const failed = new StageFonts();
    await assert.rejects(
      failed.load([
        { family: "ok", source: "a" },
        { family: "broken", source: "b" },
      ]),
      /decode/,
    );
    assert.equal(registered.size, 0);
  } finally {
    for (const [key, descriptor] of [
      ["FontFace", oldFace],
      ["document", oldDocument],
    ] as const)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
