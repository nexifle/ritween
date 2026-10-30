import {
  createScene,
  C,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";
import { pipelineTiming } from "../pipeline-timing";

export default function pipeline() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  const { circle, text, rect, header, path, arrow, poly } = d;
  header(
    "05 / RENDER PIPELINE",
    "Built to keep moving.",
    "Source → GPU → frames → video",
    t,
  );
  const xs = [290, 730, 1170, 1610];
  const cols = [C.white, C.blue, C.lime, C.coral];
  for (let i = 0; i < 4; i++) {
    const a = ease((t - i * pipelineTiming.stagger) / pipelineTiming.settle);
    rect(xs[i] - 140, 460 + 40 * (1 - a), 280, 230, cols[i], a);
    path(
      [
        [xs[i] - 140, 460],
        [xs[i] + 140, 460],
        [xs[i] + 140, 690],
        [xs[i] - 140, 690],
      ],
      C.ink,
      4,
      a,
      true,
    );
    text(
      ["SOURCE", "WEBGPU", "FRAMES", "MP4"][i],
      xs[i],
      735,
      27,
      C.ink,
      a,
      "center",
    );
    if (i < 3) arrow(xs[i] + 158, 575, xs[i] + 280, 575, C.ink, 4);
  }
  // Code lines become parallel GPU lanes, then an ordered stack of frames.
  for (let j = 0; j < 5; j++) {
    rect(190, 500 + j * 30, 85 + (j % 3) * 27, 8, j % 2 ? C.coral : C.blue);
    rect(635, 500 + j * 30, 190, 9, C.white, 0.8);
  }
  for (let j = 0; j < 3; j++) {
    const x = 1080 + j * 22,
      y = 510 - j * 15;
    rect(x, y, 145, 110, C.paper);
    path(
      [
        [x, y],
        [x + 145, y],
        [x + 145, y + 110],
        [x, y + 110],
      ],
      C.ink,
      3,
      1,
      true,
    );
    circle(x + 72, y + 55, 26, C.blue);
  }
  poly(
    [
      [1580, 520],
      [1580, 625],
      [1670, 572],
    ],
    C.ink,
  );
  for (let i = 0; i < pipelineTiming.dotCount; i++) {
    const f = (t * pipelineTiming.dotSpeed + i / pipelineTiming.dotCount) % 1;
    const x = pipelineTiming.dotStart + f * pipelineTiming.dotDistance;
    circle(x, 835, 7, i % 2 ? C.blue : C.coral);
  }
  text("Evaluate the timeline", 290, 794, 22, C.muted, 1, "center");
  text("Draw on the GPU", 730, 794, 22, C.muted, 1, "center");
  text("Encode the frames", 1610, 794, 22, C.muted, 1, "center");
  text("A direct path from code to motion.", 960, 916, 34, C.ink, 1, "center");
}
