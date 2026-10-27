import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRulerTime,
  rulerMarks,
  rulerStep,
} from "../src/preview/utils/view-utils";

test("ruler uses readable whole-second intervals at overview zoom", () => {
  for (const fps of [24, 25, 30, 60]) {
    for (const pixels of [1, 14, 40, 78]) {
      assert.equal(rulerStep(pixels, fps) % 1, 0);
    }
  }
  assert.equal(formatRulerTime(65, 5, 30), "01:05");
});

test("ruler subdivisions are dense, ordered and aligned to whole frames", () => {
  for (const fps of [24, 25, 30, 60]) {
    for (const pixels of [14, 80, 400, 4000]) {
      const { marks } = rulerMarks(90, pixels, fps, 0, 8);
      assert.ok(marks.some((mark) => mark.major));
      assert.ok(marks.length > 2);
      for (let i = 0; i < marks.length; i++) {
        assert.ok(
          Math.abs(marks[i].time * fps - Math.round(marks[i].time * fps)) <
            1e-6,
        );
        if (i) assert.ok(marks[i].time > marks[i - 1].time);
      }
    }
  }
  assert.ok(rulerMarks(90, 14, 30, 0, 90).marks.some((mark) => !mark.major));
  assert.equal(formatRulerTime(1 + 12 / 30, 0.2, 30), "00:01:12");
});

test("ruler only generates marks around the visible time range", () => {
  const { marks, major } = rulerMarks(3600, 400, 30, 120, 123);
  assert.ok(marks.length < 200);
  assert.ok(
    marks.every(
      (mark) => mark.time >= 120 - major - 1 && mark.time <= 123 + major + 1,
    ),
  );
  assert.ok(
    rulerMarks(8, 100, 30, 7, 10).marks.every((mark) => mark.time <= 8),
  );
});
