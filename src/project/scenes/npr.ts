import {
  createScene,
  C,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";

export default function npr() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  const { atlas, circle, ring, mesh, donut, box, ball, header, pill } = d;
  header(
    "02 / NPR ANIMATION",
    "A little shape. A lot of character.",
    "3D, with an illustrated attitude.",
    t,
  );
  const a = ease(t / 0.8);
  circle(960, 650, 285, C.lime, a);
  ring(960, 650, 330, C.ink, 3, 0.65, 0, Math.PI * 2);
  const bounce = Math.abs(Math.sin((t * Math.PI) / 1.6)) * 65;
  circle(520, 824, 135 - bounce * 0.3, C.ink, 0.12, 0.19);
  circle(960, 848, 145, C.ink, 0.12, 0.16);
  circle(1430, 824, 140 - bounce * 0.2, C.ink, 0.12, 0.19);
  mesh(box(1.6, 1.6, 1.6, C.blue), 520, 750 - bounce, 130 * a, t * 0.65, -0.4);
  mesh(
    donut,
    960,
    620 + Math.sin(t * 1.6) * 25,
    166 * a,
    t * 0.48,
    -0.55 + Math.sin(t) * 0.2,
  );
  mesh(ball, 1430, 660 - bounce, 157 * a, -t * 0.6, -0.1);
  for (const [label, cx, color] of [
    ["CEL SHADING", 520, C.blue],
    ["INK OUTLINES", 960, C.ink],
    ["TIMELINE ANIMATION", 1430, C.coral],
  ] as const) {
    const width = (atlas.get(label)!.w * 23) / atlas.get(label)!.size + 40;
    pill(label, cx - width / 2, 893, color);
  }
}
