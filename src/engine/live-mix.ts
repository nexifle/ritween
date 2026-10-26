import { validateProject } from "./timeline";
import type { AudioClip, Project } from "./types";

/** Notes that start together share one voice. Wider fans are mix buses. */
const CLUSTER_SPAN_SECONDS = 0.05;
const LOOKAHEAD_SECONDS = 0.35;
const PUMP_MS = 50;
const LEAD_SECONDS = 0.05;
const RELEASE_SECONDS = 0.08;

const CONSTRUCTORS = [
  "OscillatorNode",
  "GainNode",
  "BiquadFilterNode",
  "StereoPannerNode",
  "DelayNode",
  "AudioBufferSourceNode",
  "WaveShaperNode",
  "DynamicsCompressorNode",
  "ConstantSourceNode",
] as const;

const PARAM_NAMES: Record<string, readonly string[]> = {
  OscillatorNode: ["frequency", "detune"],
  GainNode: ["gain"],
  BiquadFilterNode: ["frequency", "detune", "Q", "gain"],
  StereoPannerNode: ["pan"],
  DelayNode: ["delayTime"],
  AudioBufferSourceNode: ["playbackRate", "detune"],
  DynamicsCompressorNode: ["threshold", "knee", "ratio", "attack", "release"],
  ConstantSourceNode: ["offset"],
};

const PARAM_DEFAULTS: Record<string, number> = {
  frequency: 440,
  detune: 0,
  gain: 1,
  Q: 1,
  pan: 0,
  delayTime: 0,
  playbackRate: 1,
  threshold: -24,
  knee: 30,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
  offset: 0,
};

export type ParamEvent =
  | { op: "set"; value: number; time: number }
  | { op: "linear"; value: number; time: number }
  | { op: "expo"; value: number; time: number }
  | { op: "target"; value: number; time: number; constant: number };

export class VirtualParam {
  events: ParamEvent[] = [];
  constructor(public initial: number) {}
  get value() {
    return this.initial;
  }
  set value(next: number) {
    this.initial = next;
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ op: "set", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ op: "linear", value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push({ op: "expo", value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, constant: number) {
    this.events.push({ op: "target", value, time, constant });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }
  cancelAndHoldAtTime(time: number) {
    this.initial = valueAt(this.initial, this.events, time);
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }
}

/** Value of an automated param at a composition time. */
export function valueAt(initial: number, events: readonly ParamEvent[], time: number) {
  const ordered = events.filter((event) => Number.isFinite(event.time) && Number.isFinite(event.value));
  ordered.sort((a, b) => a.time - b.time);
  let value = initial;
  let at = Number.NEGATIVE_INFINITY;
  for (const event of ordered) {
    if (event.time > time) {
      if (event.time <= at) return value;
      const u = (time - at) / (event.time - at);
      if (event.op === "linear" && at > Number.NEGATIVE_INFINITY)
        return value + (event.value - value) * u;
      if (
        event.op === "expo" &&
        at > Number.NEGATIVE_INFINITY &&
        value > 0 &&
        event.value > 0
      )
        return value * (event.value / value) ** u;
      return value;
    }
    if (event.op === "target") {
      const elapsed = Math.max(0, time - event.time);
      value = event.value + (value - event.value) * Math.exp(-elapsed / event.constant);
      at = time;
    } else {
      value = event.value;
      at = event.time;
    }
  }
  return value;
}

export type MixEdge = {
  from: number;
  to: number | null;
  output: number;
  input: number;
};

export type MixNode = {
  id: number;
  kind: string;
  start: number | null;
  stop: number | null;
  outs: number[];
};

/**
 * Nodes reached only by notes that start together form one voice.
 * A bus reached across the score stays shared and is created once.
 */
export function groupVoices(nodes: readonly MixNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reach = new Map<number, Set<number>>();
  const sources = nodes.filter((node) => node.start != null);
  for (const source of sources) {
    const seen = new Set<number>();
    const stack = [source.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      let set = reach.get(id);
      if (!set) reach.set(id, (set = new Set()));
      set.add(source.id);
      const node = byId.get(id);
      if (!node) continue;
      for (const next of node.outs) if (next != null) stack.push(next);
    }
  }
  const span = (ids: Iterable<number>) => {
    let min = Infinity;
    let max = -Infinity;
    for (const id of ids) {
      const start = byId.get(id)?.start ?? 0;
      min = Math.min(min, start);
      max = Math.max(max, start);
    }
    return max - min;
  };
  const candidates: Set<number>[] = [];
  const seenKeys = new Set<string>();
  for (const set of reach.values()) {
    if (span(set) >= CLUSTER_SPAN_SECONDS) continue;
    const key = [...set].sort((a, b) => a - b).join(",");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    candidates.push(set);
  }
  const maximal = candidates.filter(
    (set) => !candidates.some((other) => other !== set && other.size > set.size && contains(other, set)),
  );
  const voices: { ids: number[]; start: number; stop: number }[] = [];
  const claimed = new Set<number>();
  for (const set of maximal) {
    const ids: number[] = [];
    for (const node of nodes) {
      const reached = reach.get(node.id);
      if (!reached || reached.size === 0 || span(reached) >= CLUSTER_SPAN_SECONDS) continue;
      if (!contains(set, reached)) continue;
      ids.push(node.id);
      claimed.add(node.id);
    }
    const starts = [...set].map((id) => byId.get(id)?.start ?? 0);
    const stops = [...set].map((id) => byId.get(id)?.stop ?? (byId.get(id)?.start ?? 0) + 1);
    voices.push({
      ids,
      start: Math.min(...starts),
      stop: Math.max(...stops),
    });
  }
  const shared = nodes.filter((node) => !claimed.has(node.id)).map((node) => node.id);
  return { voices, shared };
}

function contains(outer: Set<number>, inner: Set<number>) {
  if (inner.size > outer.size) return false;
  for (const id of inner) if (!outer.has(id)) return false;
  return true;
}

type Edge = {
  node: Recorded | null;
  real?: AudioNode;
  output: number;
  input: number;
};

class Recorded {
  readonly params: Record<string, VirtualParam> = {};
  curve: Float32Array | null = null;
  buffer: AudioBuffer | null = null;
  loop = false;
  when: number | null = null;
  until: number | null = null;
  offset = 0;
  playDuration: number | null = null;
  readonly outs: Edge[] = [];
  constructor(
    readonly id: number,
    readonly kind: string,
    readonly options: Record<string, unknown>,
  ) {
    const names = PARAM_NAMES[kind] ?? [];
    for (const name of names) {
      const seeded = options[name];
      this.params[name] = new VirtualParam(
        typeof seeded === "number" ? seeded : (PARAM_DEFAULTS[name] ?? 0),
      );
      Object.defineProperty(this, name, { value: this.params[name], enumerable: true });
    }
    if (options.buffer instanceof AudioBuffer) this.buffer = options.buffer;
    if (options.curve instanceof Float32Array) this.curve = options.curve;
  }
  get type() {
    return this.options.type;
  }
  set type(value: unknown) {
    this.options.type = value;
  }
  connect(destination: Recorded | AudioNode, output = 0, input = 0) {
    if (destination instanceof Recorded) this.outs.push({ node: destination, output, input });
    else this.outs.push({ node: null, real: destination, output, input });
    return destination;
  }
  disconnect() {
    this.outs.length = 0;
  }
  start(when: number, offset = 0, duration?: number) {
    this.when = when;
    this.offset = offset;
    this.playDuration = duration ?? null;
  }
  stop(when: number) {
    this.until = when;
  }
}

function installRecorder(ctx: BaseAudioContext, bucket: Recorded[]) {
  const previous = new Map<string, unknown>();
  const root = globalThis as unknown as Record<string, unknown>;
  for (const name of CONSTRUCTORS) {
    const Original = root[name];
    if (typeof Original !== "function") continue;
    previous.set(name, Original);
    function Wrapped(this: unknown, context: BaseAudioContext, options?: Record<string, unknown>) {
      if (context === ctx) {
        const node = new Recorded(bucket.length, name, { ...(options ?? {}) });
        bucket.push(node);
        return node;
      }
      return new (Original as new (...args: unknown[]) => unknown)(context, options);
    }
    Wrapped.prototype = (Original as { prototype: object }).prototype;
    root[name] = Wrapped;
  }
  return () => {
    for (const [name, Original] of previous) root[name] = Original;
  };
}

type Voice = { ids: number[]; start: number; stop: number };

type ClipBus = { gain: AudioParam; start: number; duration: number; node: GainNode };

type Score = {
  audible: boolean;
  nodes: Recorded[];
  voices: Voice[];
  shared: number[];
  buses: ClipBus[];
};

function toMixNode(node: Recorded): MixNode {
  return {
    id: node.id,
    kind: node.kind,
    start: node.when,
    stop: node.until,
    outs: node.outs.flatMap((edge) => (edge.node ? [edge.node.id] : [])),
  };
}

async function recordScore(
  ctx: BaseAudioContext,
  sum: AudioNode,
  project: Project,
  mutedTrackIds: readonly string[],
) {
  const muted = new Set(mutedTrackIds);
  const tracks = (project.audioTracks ?? []).filter(
    (track) => !muted.has(track.id) && track.clips.length > 0,
  );
  const nodes: Recorded[] = [];
  const buses: ClipBus[] = [];
  if (!tracks.length) return { audible: false, nodes, voices: [], shared: [], buses } satisfies Score;
  const RealGain = globalThis.GainNode;
  const restore = installRecorder(ctx, nodes);
  try {
    for (const track of tracks) {
      for (const clip of track.clips)
        await recordClip(ctx, sum, clip, nodes, buses, RealGain);
    }
  } finally {
    restore();
  }
  const grouped = groupVoices(nodes.map(toMixNode));
  return { audible: true, nodes, voices: grouped.voices, shared: grouped.shared, buses } satisfies Score;
}

async function recordClip(
  ctx: BaseAudioContext,
  sum: AudioNode,
  clip: AudioClip,
  nodes: Recorded[],
  buses: ClipBus[],
  RealGain: typeof GainNode,
) {
  const before = nodes.length;
  const bus = new RealGain(ctx, { gain: 0 });
  bus.connect(sum);
  buses.push({ gain: bus.gain, start: clip.start, duration: clip.duration, node: bus });
  await clip.create().schedule({
    context: ctx,
    destination: bus,
    start: clip.start,
    duration: clip.duration,
    at: (localTime) => clip.start + localTime,
  });
  for (const node of nodes.slice(before)) {
    if (node.when == null) continue;
    const end = node.until ?? node.when;
    if (end < clip.start || node.when > clip.start + clip.duration) node.when = null;
  }
}

function createReal(ctx: BaseAudioContext, node: Recorded) {
  const options = node.options;
  if (node.kind === "OscillatorNode")
    return new OscillatorNode(ctx, options as OscillatorOptions);
  if (node.kind === "GainNode") return new GainNode(ctx, options as GainOptions);
  if (node.kind === "BiquadFilterNode")
    return new BiquadFilterNode(ctx, options as BiquadFilterOptions);
  if (node.kind === "StereoPannerNode")
    return new StereoPannerNode(ctx, options as StereoPannerOptions);
  if (node.kind === "DelayNode") return new DelayNode(ctx, options as DelayOptions);
  if (node.kind === "WaveShaperNode") {
    const shaper = new WaveShaperNode(ctx, options as WaveShaperOptions);
    if (node.curve) shaper.curve = new Float32Array(node.curve);
    return shaper;
  }
  if (node.kind === "DynamicsCompressorNode")
    return new DynamicsCompressorNode(ctx, options as DynamicsCompressorOptions);
  if (node.kind === "ConstantSourceNode")
    return new ConstantSourceNode(ctx, options as ConstantSourceOptions);
  const source = new AudioBufferSourceNode(ctx, {
    buffer: node.buffer,
    loop: node.loop,
    playbackRate: typeof options.playbackRate === "number" ? options.playbackRate : undefined,
  });
  return source;
}

function applyParam(
  param: AudioParam,
  recorded: VirtualParam,
  origin: number,
  compositionNow: number,
  audioNow: number,
) {
  const future = recorded.events
    .filter((event) => event.time > compositionNow + 1e-4 && origin + event.time >= audioNow)
    .sort((a, b) => a.time - b.time);
  let value = valueAt(recorded.initial, recorded.events, compositionNow);
  if (future[0]?.op === "expo" && value <= 0) value = 1e-4;
  const hold = Math.max(audioNow, origin + compositionNow);
  param.cancelScheduledValues(audioNow);
  param.setValueAtTime(value, hold);
  for (const event of future) {
    const when = origin + event.time;
    if (when <= hold + 1e-4) continue;
    if (event.op === "set") param.setValueAtTime(event.value, when);
    else if (event.op === "linear") param.linearRampToValueAtTime(event.value, when);
    else if (event.op === "expo")
      param.exponentialRampToValueAtTime(Math.max(1e-4, event.value), when);
    else param.setTargetAtTime(event.value, when, event.constant);
  }
}

function connectEdges(node: Recorded, live: Map<number, AudioNode>) {
  const source = live.get(node.id);
  if (!source) return;
  for (const edge of node.outs) {
    const destination = edge.node ? live.get(edge.node.id) : edge.real;
    if (!destination) continue;
    try {
      source.connect(destination, edge.output, edge.input);
    } catch {
      /* A feedback edge is connected once. */
    }
  }
}

/**
 * Preview mix. The score is recorded once, then only the notes inside the
 * lookahead exist as real nodes. Export keeps the offline renderer.
 */
export class LiveMix {
  private score: Score | null = null;
  private key = "";
  private origin = 0;
  private playing = false;
  private timer = 0;
  private liveVoices: { stop: number; nodes: AudioNode[] }[] = [];
  private sharedNodes: AudioNode[] = [];
  private readonly sum: GainNode;
  private readonly limiter: DynamicsCompressorNode;

  constructor(
    private readonly ctx: AudioContext,
    monitor: AudioNode,
  ) {
    this.sum = new GainNode(ctx, { gain: 1 });
    this.limiter = new DynamicsCompressorNode(ctx, {
      threshold: -1,
      knee: 0,
      ratio: 20,
      attack: 0.002,
      release: 0.12,
    });
    this.sum.connect(this.limiter).connect(monitor);
  }

  async prepare(project: Project, mutedTrackIds: readonly string[]) {
    validateProject(project);
    const key = [...mutedTrackIds].sort().join("\0");
    if (this.score && this.key === key) return this.score.audible;
    this.stop();
    this.dropBuses();
    this.score = await recordScore(this.ctx, this.sum, project, mutedTrackIds);
    this.key = key;
    return this.score.audible;
  }

  get audible() {
    return this.score?.audible ?? false;
  }

  start(from: number) {
    if (!this.score?.audible) return;
    if (this.timer) window.clearInterval(this.timer);
    this.playing = true;
    this.rebuild(from);
    this.timer = window.setInterval(() => this.pump(), PUMP_MS);
  }

  seek(time: number) {
    if (!this.playing || !this.score?.audible) return;
    this.rebuild(time);
  }

  /** Composition seconds at the speaker, or null when nothing is armed. */
  heard(latency: number) {
    if (!this.playing) return null;
    return Math.max(0, this.ctx.currentTime - this.origin - latency);
  }

  stop() {
    this.playing = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.releaseRendered(this.ctx.currentTime);
  }

  dispose() {
    this.stop();
    this.dropBuses();
    this.score = null;
    this.sum.disconnect();
    this.limiter.disconnect();
  }

  private rebuild(from: number) {
    this.releaseRendered(this.ctx.currentTime);
    this.origin = this.ctx.currentTime + LEAD_SECONDS - from;
    this.renderShared(from);
    this.armBuses(from);
    this.pump();
  }

  private renderShared(from: number) {
    if (!this.score) return;
    const live = new Map<number, AudioNode>();
    for (const id of this.score.shared) {
      const node = this.score.nodes[id];
      if (!node) continue;
      const real = createReal(this.ctx, node);
      live.set(id, real);
      this.sharedNodes.push(real);
    }
    for (const id of this.score.shared) connectEdges(this.score.nodes[id], live);
    const audioNow = this.ctx.currentTime;
    for (const id of this.score.shared) {
      const node = this.score.nodes[id];
      const real = live.get(id);
      if (!node || !real) continue;
      this.automate(node, real, from, audioNow);
      this.startIfScheduled(node, real, audioNow);
    }
  }

  private readonly owned = new Set<Voice>();

  private pump() {
    if (!this.playing || !this.score) return;
    const compositionNow = this.ctx.currentTime - this.origin;
    const horizon = compositionNow + LOOKAHEAD_SECONDS;
    const audioNow = this.ctx.currentTime;
    this.liveVoices = this.liveVoices.filter((voice) => {
      if (voice.stop >= compositionNow - RELEASE_SECONDS) return true;
      for (const node of voice.nodes) node.disconnect();
      return false;
    });
    for (const voice of this.score.voices) {
      if (this.owned.has(voice)) continue;
      if (voice.stop < compositionNow - RELEASE_SECONDS) continue;
      if (voice.start > horizon) continue;
      this.liveVoices.push(this.materialize(voice, compositionNow, audioNow));
      this.owned.add(voice);
    }
  }

  private materialize(voice: Voice, compositionNow: number, audioNow: number) {
    const live = new Map<number, AudioNode>();
    for (const id of this.score?.shared ?? []) {
      const real = this.sharedNodes[this.score!.shared.indexOf(id)];
      if (real) live.set(id, real);
    }
    const created: AudioNode[] = [];
    for (const id of voice.ids) {
      const node = this.score!.nodes[id];
      const real = createReal(this.ctx, node);
      live.set(id, real);
      created.push(real);
    }
    for (const id of voice.ids) connectEdges(this.score!.nodes[id], live);
    for (const id of this.score!.shared) connectEdges(this.score!.nodes[id], live);
    for (let index = 0; index < voice.ids.length; index++) {
      const node = this.score!.nodes[voice.ids[index]];
      const real = created[index];
      this.automate(node, real, Math.max(compositionNow, voice.start), audioNow);
      this.startIfScheduled(node, real, audioNow);
    }
    return { stop: voice.stop, nodes: created };
  }

  private automate(node: Recorded, real: AudioNode, compositionNow: number, audioNow: number) {
    for (const [name, recorded] of Object.entries(node.params)) {
      const param = (real as unknown as Record<string, AudioParam>)[name];
      if (!param || typeof param.setValueAtTime !== "function") continue;
      try {
        applyParam(param, recorded, this.origin, compositionNow, audioNow);
      } catch {
        /* A ramp aimed at silence stays on the initial value. */
      }
    }
  }

  private startIfScheduled(node: Recorded, real: AudioNode, audioNow: number) {
    if (node.when == null || !("start" in real)) return;
    const scheduled = this.origin + node.when;
    const when = Math.max(scheduled, audioNow + 0.005);
    const end = this.origin + (node.until ?? node.when + 30);
    if (end <= when) return;
    const source = real as AudioBufferSourceNode;
    try {
      if (node.kind === "AudioBufferSourceNode") {
        const late = Math.max(0, when - scheduled);
        const duration = node.playDuration == null ? undefined : Math.max(0.01, node.playDuration - late);
        if (duration == null) source.start(when, node.offset + late);
        else source.start(when, node.offset + late, duration);
      } else source.start(when);
      source.stop(Math.max(end, when + 0.01));
    } catch {
      /* Already started, or the note ended inside this window. */
    }
  }

  private armBuses(from: number) {
    if (!this.score) return;
    const audioNow = this.ctx.currentTime;
    for (const bus of this.score.buses) armBus(bus, this.origin, from, audioNow);
  }

  private releaseRendered(audioNow: number) {
    for (const voice of this.liveVoices) {
      for (const node of voice.nodes) silence(node, audioNow);
    }
    for (const node of this.sharedNodes) silence(node, audioNow);
    this.liveVoices = [];
    this.sharedNodes = [];
    this.owned.clear();
  }

  private dropBuses() {
    for (const bus of this.score?.buses ?? []) bus.node.disconnect();
    if (this.score) this.score.buses = [];
  }
}

function armBus(bus: ClipBus, origin: number, from: number, audioNow: number) {
  const ramp = Math.min(0.005, bus.duration / 2);
  const open = origin + bus.start;
  const close = open + bus.duration;
  const gain = bus.gain;
  gain.cancelScheduledValues(audioNow);
  if (close <= audioNow) {
    gain.setValueAtTime(0, audioNow);
    return;
  }
  if (from <= bus.start + 1e-4) {
    gain.setValueAtTime(0, audioNow);
    if (open > audioNow) gain.setValueAtTime(0, open);
    gain.linearRampToValueAtTime(1, Math.max(open + ramp, audioNow + 0.001));
  } else gain.setValueAtTime(1, audioNow);
  const releaseAt = Math.max(close - ramp, audioNow + 0.002);
  gain.setValueAtTime(1, releaseAt);
  gain.linearRampToValueAtTime(0, Math.max(close, releaseAt + 0.001));
}

function silence(node: AudioNode, audioNow: number) {
  try {
    if ("stop" in node) (node as AudioBufferSourceNode).stop(audioNow + 0.02);
  } catch {
    /* Not started. */
  }
  try {
    node.disconnect();
  } catch {
    /* Already disconnected. */
  }
}
