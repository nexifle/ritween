import {
  createScene,
  C,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";

export default function opening() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  const { circle, ring, mesh, donut, box, ball, logo, text, rect, line } = d;
  const a = ease(t / 0.9),
    settle = ease((t - 0.25) / 1.2);
  const cx = mix(1500, 1490, settle);
  circle(1460, 560, 300, C.lime);
  ring(1460, 560, 340, C.ink, 3, 1, -1 + t * 0.15, 3.8 + t * 0.15);
  mesh(donut, cx, 550, 142, t * 0.55, -0.55);
  mesh(box(1, 1, 1, C.blue), 1220, 760, 92, t * 0.5, -0.3);
  mesh(ball, 1690, 330, 90, -t * 0.4, -0.4);
  logo(105, 155, 108, a);
  text("ritween", 94, 300 + 45 * (1 - a), 184, C.ink, a);
  text(
    "Ritween features, source to motion",
    105,
    526,
    35,
    C.ink,
    ease((t - 0.7) / 0.7),
  );
  rect(105, 606, 660 * ease((t - 1) / 1), 5, C.coral);
  text("MAKE IDEAS MOVE.", 105, 654, 24, C.blue, ease((t - 1.4) / 0.6));
  for (let i = 0; i < 4; i++) {
    const x = 130 + i * 108;
    circle(
      x,
      800,
      16 + 4 * Math.sin(t * 3 - i),
      [C.blue, C.coral, C.lime, C.ink][i],
    );
    if (i < 3) line(x + 25, 800, x + 80, 800, C.ink, 2);
  }
}
