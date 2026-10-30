import type { AudioClipSource, AudioHost } from "../../engine/types";
const BPM = 120,
  beat = 60 / BPM;
function tone(
  h: AudioHost,
  t: number,
  d: number,
  f: number,
  vol: number,
  type: OscillatorType = "sine",
  end?: number,
  pan = 0,
) {
  if (t + d > h.duration) d = h.duration - t;
  if (d <= 0) return;
  const c = h.context,
    o = c.createOscillator(),
    g = c.createGain(),
    p = c.createStereoPanner();
  o.type = type;
  o.frequency.setValueAtTime(f, h.at(t));
  if (end) o.frequency.exponentialRampToValueAtTime(end, h.at(t + d));
  g.gain.setValueAtTime(0, h.at(t));
  g.gain.linearRampToValueAtTime(vol * 2, h.at(t + 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, h.at(t + d));
  p.pan.value = pan;
  o.connect(g).connect(p).connect(h.destination);
  o.start(h.at(t));
  o.stop(h.at(t + d));
}
function noise(
  h: AudioHost,
  t: number,
  d: number,
  vol: number,
  freq: number,
  seed = 1,
) {
  const c = h.context,
    b = c.createBuffer(1, Math.ceil(c.sampleRate * d), c.sampleRate),
    a = b.getChannelData(0);
  let s = seed;
  for (let i = 0; i < a.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    a[i] = s / 2147483648;
  }
  const src = c.createBufferSource(),
    g = c.createGain(),
    filter = c.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = freq;
  src.buffer = b;
  g.gain.setValueAtTime(vol * 2, h.at(t));
  g.gain.exponentialRampToValueAtTime(
    0.0001,
    h.at(Math.min(t + d, h.duration)),
  );
  src.connect(filter).connect(g).connect(h.destination);
  src.start(h.at(t));
  src.stop(h.at(Math.min(t + d, h.duration)));
}
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export function score(): AudioClipSource {
  return {
    schedule(h) {
      // Original 120 BPM arrangement: D minor → Bb → F → C, with a half-time synth break.
      const roots = [38, 34, 41, 36],
        melody = [74, 77, 81, 77, 72, 74, 69, 72];
      for (let step = 0; step < 512; step++) {
        const t = step * 0.125;
        if (t >= h.duration - 0.5) break;
        const ending = t > 39,
          intro = t < 6,
          breakdown = t >= 16 && t < 21;
        const fade = Math.min(1, t / 2, (h.duration - t) / 3);
        const root = roots[Math.floor(t / 4) % 4];
        if (step % 4 === 0 && !ending) {
          tone(h, t, 0.24, 145, 0.24 * fade, "sine", 44);
          tone(h, t, 0.07, 900, 0.035 * fade, "triangle", 90);
        }
        if (step % 8 === 4 && !intro && !ending) {
          noise(h, t, 0.18, 0.095 * fade, 1100, step + 1);
          tone(h, t, 0.13, 180, 0.055 * fade, "triangle", 65);
        }
        if (step % 2 === 0 && !ending)
          noise(
            h,
            t,
            step % 8 === 6 ? 0.16 : 0.055,
            (step % 4 === 0 ? 0.025 : 0.045) * fade,
            7000,
            step + 72,
          );
        if (step % 2 === 0) {
          const n =
            root + [0, 0, 12, 7, 0, 12, 7, 10][Math.floor(step / 2) % 8];
          tone(
            h,
            t,
            0.19,
            hz(n),
            0.095 * fade * (breakdown ? 0.65 : 1),
            "triangle",
          );
          tone(h, t, 0.16, hz(n + 12), 0.022 * fade, "sawtooth");
        }
        if (step % 4 === 0) {
          const n =
            melody[Math.floor(step / 4) % 8] +
            (Math.floor(t / 4) % 4 === 1 ? -2 : 0);
          tone(
            h,
            t,
            0.42,
            hz(n),
            0.035 * fade * (intro ? 0.6 : 1),
            "sine",
            undefined,
            step % 8 === 0 ? -0.28 : 0.28,
          );
          tone(
            h,
            t + 0.1875,
            0.35,
            hz(n),
            0.011 * fade,
            "sine",
            undefined,
            -0.4,
          );
        }
        if (step % 32 === 0) {
          for (const n of [root + 24, root + 31, root + 36])
            tone(
              h,
              t,
              3.5,
              hz(n),
              0.024 * fade,
              "triangle",
              undefined,
              ((n % 3) - 1) * 0.4,
            );
        }
      }
      for (const n of [50, 57, 62, 65, 69, 74])
        tone(h, 41, 3.8, hz(n), 0.025, "sine");
    },
  };
}
export function effects(): AudioClipSource {
  return {
    schedule(h) {
      const cuts = [0, 6, 11, 16, 21, 27, 39];
      for (const t of cuts) {
        tone(h, t, 0.65, 110, 0.22, "sine", 32);
        noise(h, t, 0.38, 0.085, 1800, t + 9);
        if (t > 0) {
          tone(h, t - 0.45, 0.43, 180, 0.055, "sine", 1600);
          noise(h, t - 0.35, 0.34, 0.035, 3000, t + 21);
        }
      }
      for (const t of [
        6.2, 6.4, 6.6, 6.8, 7, 11.8, 13.4, 15, 16.5, 17, 17.5, 18, 18.5, 19,
        19.5, 20, 21, 22.5, 24,
      ])
        tone(
          h,
          t,
          0.12,
          700 + (Math.floor(t * 10) % 6) * 160,
          0.055,
          "sine",
          400,
          (t % 1) - 0.5,
        );
      tone(h, 25.5, 0.8, 190, 0.3, "sine", 28);
      noise(h, 25.5, 0.55, 0.14, 600, 51);
      // Benchmark lands on the score's D-minor bar; no competing ticks or pitch sweeps.
      tone(h, 32, 0.3, hz(50), 0.06, "sine");
      for (const n of [74, 77, 81]) tone(h, 34, 0.65, hz(n), 0.018, "sine");
    },
  };
}
