import {
  createScene,
  C,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";

export default function closing() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  const { circle, mesh, donut, box, ball, logo, text, rect } = d;
  const a = ease(t / 0.9);
  circle(1510, 550, 300, C.lime);
  mesh(donut, 1530, 520, 165, t * 0.3, -0.6);
  mesh(box(0.8, 0.8, 0.8, C.blue), 1310, 775, 94, t * 0.4, -0.4);
  mesh(ball, 1720, 330, 80, -t * 0.3);
  logo(109, 155, 108, a);
  text("ritween", 99, 298 + 30 * (1 - a), 166, C.ink, a);
  text("ritween source to motion", 109, 510, 36, C.ink, a);
  rect(110, 594, 670 * ease((t - 0.5) / 1), 5, C.coral);
  text("More frames. Less wait.", 105, 646, 58, C.blue, ease((t - 0.8) / 0.8));
  text("IMAGINE. CODE. MOVE.", 110, 791, 23, C.muted, ease((t - 1.4) / 0.8));
}
