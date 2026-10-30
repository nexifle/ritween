import {
  createScene,
  C,
  ease,
  smooth,
  mix,
  type Drawing,
  type Face,
} from "./shared";

export default function benchmark() {
  return createScene(draw);
}

function draw(d: Drawing, t: number) {
  const { text, rect, line, header } = d;
  header("06 / BENCHMARK", "Less time rendering.", "More time creating.", t);
  text("MEDIAN EXPORT TIME / LOWER IS BETTER", 100, 320, 23, C.muted);
  const x = 560,
    width = 730;
  for (let i = 0; i < 4; i++) {
    const xx = x + (i / 3) * width;
    line(xx, 390, xx, 768, C.ink, 1, 0.15);
    text(["0 s", "50", "100", "150 s"][i], xx, 786, 20, C.muted, 1, "center");
  }
  const values = [41.791, 131.62, 149.479],
    labs = [
      "Ritween",
      "Other tool · prepared audio",
      "Other tool · audio + export",
    ];
  for (let i = 0; i < 3; i++) {
    const y = 423 + i * 112;
    const a = ease((t - 0.3 - i * 0.2) / 1.7);
    text(labs[i], 100, y + 10, i === 0 ? 35 : 27);
    rect(
      x,
      y,
      (values[i] / 150) * width * a,
      62,
      [C.blue, "#B4B9BA", "#818A91"][i],
    );
    text(
      ["41.791 s", "131.620 s", "149.479 s"][i],
      x + (values[i] / 150) * width * a + 18,
      y + 13,
      26,
      C.ink,
      a,
    );
  }
  const a = ease((t - 2) / 0.7);
  text("3.58×", 1785, 407, 88, C.blue, a, "right");
  text("faster end-to-end in this test", 1780, 521, 20, C.ink, a, "right");
  text("129.21", 1780, 630, 64, C.ink, a, "right");
  text("effective export FPS", 1780, 711, 22, C.muted, a, "right");
  text("Ritween includes audio synthesis during export.", 100, 851, 25, C.blue);
  text(
    "Supplied benchmark • Apple M1 / 16 GB • 90 s / 1080×1920 / 60 fps / 5,400 frames",
    100,
    901,
    21,
    C.muted,
  );
  text(
    "Median of 3 measured runs after 1 warm-up • Ritween 0.2.4 • Results vary by workload.",
    100,
    935,
    19,
    C.muted,
  );
}
