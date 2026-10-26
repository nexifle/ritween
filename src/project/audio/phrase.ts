import type { AudioClipSource } from "../../engine/types";

/** One phrase factory, placed more than once. Pitch is the only difference. */
export function phrase(pitch: number): () => AudioClipSource {
  return () => ({
    schedule(host) {
      const semis = [0, 2, 4, 7, 4, 2];
      const step = host.duration / semis.length;
      for (let i = 0; i < semis.length; i++) {
        const time = host.at(i * step);
        const osc = new OscillatorNode(host.context, {
          type: "sine",
          frequency: pitch * 2 ** (semis[i] / 12),
        });
        const amp = new GainNode(host.context, { gain: 0 });
        osc.connect(amp).connect(host.destination);
        const peak = 0.2;
        amp.gain.setValueAtTime(0, time);
        amp.gain.linearRampToValueAtTime(peak, time + 0.01);
        amp.gain.setTargetAtTime(0, time + step * 0.7, 0.03);
        osc.start(time);
        osc.stop(time + step);
      }
    },
  });
}
