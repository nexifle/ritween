import {
  createScene,
  C,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";

export default function charts() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  const { circle, mesh, donut, box, text, line, header, path } = d;
  header(
    "01 / CHARTS",
    "Data with dimension.",
    "Charts that tell the story.",
    t,
  );
  const centers = [345, 760, 1175, 1590];
  for (let i = 0; i < 4; i++) {
    circle(centers[i], 820, 155, C.ink, 0.055, 0.22);
    text(
      ["BARS", "DONUT", "LINE", "SCATTER"][i],
      centers[i],
      868,
      24,
      C.ink,
      1,
      "center",
    );
  }
  const a = ease(t / 0.9);
  const bars: Face[] = [];
  for (let i = 0; i < 5; i++) {
    const h =
      (0.7 + [0.3, 1, 0.6, 1.6, 1.15][i]) *
      ease((t - i * 0.12) / 1.1) *
      (1 + 0.08 * Math.sin(t * 1.5 + i));
    bars.push(...box(0.34, h, 0.5, i % 2 ? C.coral : C.blue, (i - 2) * 0.5));
  }
  mesh(bars, 345, 792, 105, -0.48 + 0.07 * Math.sin(t), -0.28);
  mesh(donut, 760, 620, 101 * a, t * 0.35, -0.7);
  const p: number[][] = [];
  for (let i = 0; i < 6; i++) {
    p.push([
      1020 + i * 60,
      735 - [0, 40, 20, 120, 100, 190][i] * ease((t - 0.2 * i) / 1),
    ]);
  }
  path(
    [
      [1010, 460],
      [1010, 793],
      [1350, 793],
    ],
    C.ink,
    3,
  );
  path(p, C.blue, 8);
  for (const v of p) circle(v[0], v[1], 10, C.coral);
  path(
    [
      [1445, 460],
      [1445, 793],
      [1770, 793],
    ],
    C.ink,
    3,
  );
  for (let i = 0; i < 22; i++) {
    const x = 1470 + ((i * 67) % 270),
      y = 753 - ((i * 43) % 220);
    circle(
      mix(1590, x, a),
      mix(790, y, a),
      8 + (i % 3) * 3,
      i % 3 === 0 ? C.coral : C.blue,
      0.8,
    );
  }
  text(
    "From values to visual rhythm.",
    960,
    327,
    33,
    C.muted,
    ease((t - 1) / 0.7),
    "center",
  );
  // A linked marker travels across the gallery, making the four chart families one system.
  const x =
    345 + 1245 * (0.5 - 0.5 * Math.cos(Math.min(t / 8, 1) * Math.PI * 2));
  circle(x, 400, 10, C.coral);
  line(345, 400, 1590, 400, C.ink, 2, 0.2);
}
