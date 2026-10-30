import {
  createScene,
  C,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";

export default function synthesis() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  const { text, rect, line, header, path, pill, arrow } = d;
  header(
    "03 / SOUND SYNTHESIS",
    "Sound, from the source.",
    "Oscillators. Envelopes. Rhythm.",
    t,
  );
  const xs = [330, 960, 1590],
    labels = ["WAVEFORM", "ENVELOPE", "OUTPUT"];
  for (let j = 0; j < 3; j++) {
    text(labels[j], xs[j], 365, 23, C.blue, 1, "center");
    rect(xs[j] - 220, 435, 440, 305, j === 1 ? C.ink : C.white);
    path(
      [
        [xs[j] - 220, 435],
        [xs[j] + 220, 435],
        [xs[j] + 220, 740],
        [xs[j] - 220, 740],
      ],
      C.ink,
      3,
      1,
      true,
    );
  }
  const p = [];
  for (let i = 0; i <= 160; i++) {
    const x = i / 160,
      phase = x * 3 * Math.PI * 2 - t * 3;
    p.push([110 + x * 440, 587 + Math.sin(phase) * 85]);
  }
  path(p, C.blue, 6);
  path(
    [
      [775, 680],
      [825, 482],
      [900, 540],
      [1040, 540],
      [1140, 680],
    ],
    C.lime,
    6,
  );
  const scan = 775 + ((t % 2) / 2) * 365;
  line(scan, 450, scan, 720, C.coral, 2);
  for (let i = 0; i < 25; i++) {
    const h =
      25 +
      120 *
        Math.abs(Math.sin(i * 1.7 + t * 4)) *
        Math.pow(Math.sin((i / 24) * Math.PI), 0.5);
    rect(1390 + i * 16, 590 - h, 9, h * 2, i % 3 === 0 ? C.coral : C.blue);
  }
  arrow(570, 587, 710, 587, C.coral, 5);
  arrow(1210, 587, 1350, 587, C.coral, 5);
  pill("SINE", 165, 778);
  pill("SAW", 300, 778, C.coral);
  pill("PULSE", 428, 778, C.ink);
  text("Picture and sound. One timeline.", 960, 868, 37, C.ink, 1, "center");
  text("SYNTHESIS → SOUNDTRACK", 960, 928, 21, C.muted, 1, "center");
}
