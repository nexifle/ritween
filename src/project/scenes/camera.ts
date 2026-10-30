import {
  createScene,
  C,
  clamp,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";

export default function camera() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  t = (t * 4) / 3;
  const { ring, mesh, box, text, rect, line, header } = d;
  header(
    "04 / CAMERA & IMPACT",
    "Change your perspective.",
    "Orbit. Dolly. Boom.",
    t,
  );
  const stage = Math.min(3, Math.floor(t / 2));
  const q = t - stage * 2;
  let ry = 0.4,
    rx = -0.3,
    scale = 145,
    cy = 710;
  if (stage === 0) ry = 0.4 + q * 1.9;
  if (stage === 1) {
    ry = 4.2;
    scale = mix(130, 160, smooth(q / 1.7));
  }
  if (stage === 2) {
    ry = 4.2;
    scale = 150;
    rx = mix(-0.15, -0.95, smooth(q / 1.7));
    cy = mix(760, 650, smooth(q / 1.7));
  }
  if (stage === 3) {
    ry = 4.2 + q * 0.4;
    scale = 170 + 25 * Math.exp(-q * 5) * Math.sin(q * 22);
  }
  for (let i = -4; i <= 4; i++) {
    const yy = 815 + i * 28;
    line(590 - i * 32, yy, 1510 + i * 32, yy, C.ink, 1, 0.12);
  }
  const forms = [
    ...box(1.25, 1.7, 1.25, C.blue, -1.5),
    ...box(1.1, 0.8, 1.1, C.coral, 1.6),
    ...box(1, 2.7, 1, C.coral, 0),
  ];
  mesh(forms, 1100, cy, scale, ry, rx);
  for (let i = 0; i < 4; i++) {
    const active = i === stage;
    rect(100, 390 + i * 107, 300, 77, active ? C.ink : C.white);
    text(
      ["ORBIT", "DOLLY IN", "BOOM UP", "IMPACT"][i],
      127,
      409 + i * 107,
      30,
      active ? C.lime : C.muted,
    );
  }
  if (stage === 3) {
    const r = 60 + q * 260;
    ring(1100, 660, r, C.coral, 7 * (1 - clamp(q / 2)), 0.65);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      line(
        1100 + Math.cos(a) * (r + 20),
        660 + Math.sin(a) * (r + 20) * 0.65,
        1100 + Math.cos(a) * (r + 55),
        660 + Math.sin(a) * (r + 55) * 0.65,
        C.coral,
        4,
        1 - clamp(q / 2),
      );
    }
  }
  text(
    "Camera motion, choreographed in code.",
    960,
    903,
    31,
    C.muted,
    1,
    "center",
  );
}
