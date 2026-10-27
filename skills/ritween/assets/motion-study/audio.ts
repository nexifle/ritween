import type { AudioClipSource } from "ritween";

// A short, low-level cue: its timing belongs to the manifest, not the render loop.
export function accent(frequency: number): AudioClipSource {
  return {
    schedule(host) {
      const start = host.at(0);
      const end = host.at(host.duration);
      const oscillator = host.context.createOscillator();
      const gain = host.context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.86, end);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.038, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.001, end - 0.008);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain).connect(host.destination);
      oscillator.start(start);
      oscillator.stop(end);
    },
  };
}
