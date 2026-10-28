import {
  audibleAudioTracks,
  mutedAudioClipIds,
  mutedAudioTrackIds,
} from "../project-settings";
import { validateProject } from "../timeline";
import type { AudioClip, Project } from "../types";

/** Notes that start together share one voice. Wider fans are mix buses. */
const CLUSTER_SPAN_SECONDS = 0.05;
const LOOKAHEAD_SECONDS = 0.35;
const PUMP_MS = 50;
const LEAD_SECONDS = 0.05;
const RELEASE_SECONDS = 0.08;

export const AUDIO_LIMITS = Object.freeze({
  nodes: 16_000,
  graphVisits: 1_000_000,
  edges: 64_000,
  automationEvents: 200_000,
  sourceBufferBytes: 128 * 2 ** 20,
  delaySeconds: 60,
  scheduleTimeoutMs: 30_000,
  mixBufferBytes: 256 * 2 ** 20,
});

type Budget = {
  nodes: number;
  edges: number;
  events: number;
  bytes: number;
  delaySeconds: number;
  buffers: WeakSet<AudioBuffer>;
  destinations: WeakMap<object, AudioNode>;
  assertActive?: () => void;
  pendingDecodes: number;
};
const count = (
  budget: Budget,
  key: "nodes" | "edges" | "events",
  limit: number,
) => {
  if (++budget[key] > limit)
    throw Error(
      `Audio ${key} limit exceeded (${limit}). Simplify the score or use pre-rendered samples.`,
    );
};
const finite = (value: number, name: string, min = -Infinity) => {
  if (!Number.isFinite(value) || value < min)
    throw Error(`Invalid audio ${name}: ${value}.`);
};

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
  "ConvolverNode",
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
  | { op: "target"; value: number; time: number; constant: number }
  | {
      op: "curve";
      value: number;
      values: Float32Array;
      time: number;
      duration: number;
    };
type ParamOperation = ParamEvent | { op: "cancel" | "hold"; time: number };

export class VirtualParam {
  events: ParamEvent[] = [];
  operations: ParamOperation[] = [];
  originalInitial: number;
  owner?: { node: Recorded; name: string };
  constructor(
    public initial: number,
    private readonly budget?: Budget,
  ) {
    finite(initial, "parameter value");
    this.originalInitial = initial;
  }
  private record(event: ParamEvent) {
    this.budget?.assertActive?.();
    finite(event.value, "parameter value");
    finite(event.time, "automation time", 0);
    if (event.op === "expo" && event.value <= 0)
      throw Error("Exponential audio ramps require positive values.");
    if (event.op === "target")
      finite(event.constant, "time constant", Number.MIN_VALUE);
    if (this.budget)
      count(this.budget, "events", AUDIO_LIMITS.automationEvents);
    this.events.push(event);
    this.operations.push(event);
  }
  get value() {
    return this.initial;
  }
  set value(next: number) {
    this.budget?.assertActive?.();
    finite(next, "parameter value");
    this.initial = next;
    this.originalInitial = next;
  }
  setValueAtTime(value: number, time: number) {
    this.record({ op: "set", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.record({ op: "linear", value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.record({ op: "expo", value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, constant: number) {
    this.record({ op: "target", value, time, constant });
    return this;
  }
  setValueCurveAtTime(values: Float32Array, time: number, duration: number) {
    finite(duration, "curve duration", Number.MIN_VALUE);
    if (values.length < 2 || values.length > 65_536)
      throw Error("Audio curves need 2..65536 samples.");
    for (const value of values) finite(value, "curve value");
    if (
      this.budget &&
      (this.budget.bytes += values.length * 4) > AUDIO_LIMITS.sourceBufferBytes
    )
      throw Error("Audio curves exceed the 128 MiB source budget.");
    this.record({
      op: "curve",
      value: values[values.length - 1],
      values: new Float32Array(values),
      time,
      duration,
    });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.budget?.assertActive?.();
    finite(time, "cancellation time", 0);
    if (this.budget)
      count(this.budget, "events", AUDIO_LIMITS.automationEvents);
    this.operations.push({ op: "cancel", time });
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }
  cancelAndHoldAtTime(time: number) {
    this.budget?.assertActive?.();
    finite(time, "hold time", 0);
    if (this.budget)
      count(this.budget, "events", AUDIO_LIMITS.automationEvents);
    this.operations.push({ op: "hold", time });
    this.initial = valueAt(this.initial, this.events, time);
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }
}

/** Value of an automated param at a composition time. */
export function valueAt(
  initial: number,
  events: readonly ParamEvent[],
  time: number,
) {
  const ordered = events.filter(
    (event) => Number.isFinite(event.time) && Number.isFinite(event.value),
  );
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
    if (event.op === "curve") {
      const position =
        Math.min(1, Math.max(0, (time - event.time) / event.duration)) *
        (event.values.length - 1);
      const index = Math.floor(position);
      value =
        event.values[index] +
        ((event.values[index + 1] ?? event.values[index]) -
          event.values[index]) *
          (position - index);
      at = Math.min(time, event.time + event.duration);
    } else if (event.op === "target") {
      const elapsed = Math.max(0, time - event.time);
      value =
        event.value +
        (value - event.value) * Math.exp(-elapsed / event.constant);
      at = time;
    } else {
      value = event.value;
      at = event.time;
    }
  }
  return value;
}

/** Advance a buffer offset using native loop playback's first pass and loop range. */
export function offsetAfterElapsed(
  offset: number,
  elapsed: number,
  loopStart: number,
  loopEnd: number,
) {
  const advanced = offset + Math.max(0, elapsed);
  const loopDuration = loopEnd - loopStart;
  if (loopDuration <= 0 || advanced < loopEnd) return advanced;
  return loopStart + ((advanced - loopEnd) % loopDuration);
}

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
  let visits = 0;
  for (const source of sources) {
    const seen = new Set<number>();
    const stack = [source.id];
    while (stack.length) {
      if (++visits > AUDIO_LIMITS.graphVisits)
        throw Error(
          "Audio graph traversal limit exceeded. Simplify shared routing.",
        );
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
  const spans = new Map<Iterable<number>, number>();
  const span = (ids: Iterable<number>) => {
    const cached = spans.get(ids);
    if (cached != null) return cached;
    let min = Infinity;
    let max = -Infinity;
    for (const id of ids) {
      const start = byId.get(id)?.start ?? 0;
      min = Math.min(min, start);
      max = Math.max(max, start);
    }
    const result = max - min;
    spans.set(ids, result);
    return result;
  };
  // Union sources only when a downstream private node couples their starts.
  // Classify each node once; avoid scanning the whole graph for every voice.
  const parent = new Map(sources.map((source) => [source.id, source.id]));
  const root = (id: number): number => {
    let result = id;
    while (parent.get(result) !== result) result = parent.get(result)!;
    while (id !== result) {
      const next = parent.get(id)!;
      parent.set(id, result);
      id = next;
    }
    return result;
  };
  for (const set of reach.values()) {
    if (span(set) >= CLUSTER_SPAN_SECONDS) continue;
    const ids = [...set];
    for (let i = 1; i < ids.length; i++) parent.set(root(ids[i]), root(ids[0]));
  }
  const components = new Map<number, Set<number>>();
  for (const source of sources) {
    const id = root(source.id);
    if (!components.has(id)) components.set(id, new Set());
    components.get(id)!.add(source.id);
  }
  const groups = new Map<
    number,
    { ids: number[]; start: number; stop: number }
  >();
  for (const [id, set] of components) {
    // An overlapping chain spanning distant starts must stay shared, not be
    // duplicated into independent voices with separate filter/effect state.
    if (span(set) >= CLUSTER_SPAN_SECONDS) continue;
    const sources = [...set].map((id) => byId.get(id)!);
    groups.set(id, {
      ids: [],
      start: Math.min(...sources.map((s) => s.start!)),
      stop: Math.max(...sources.map((s) => s.stop ?? s.start! + 1)),
    });
  }
  const shared: number[] = [];
  for (const node of nodes) {
    const set = reach.get(node.id);
    const first = set?.values().next().value;
    const group =
      first == null || !set || span(set) >= CLUSTER_SPAN_SECONDS
        ? undefined
        : groups.get(root(first));
    if (group) group.ids.push(node.id);
    else shared.push(node.id);
  }
  return { voices: [...groups.values()], shared };
}

type Edge = {
  node: Recorded | null;
  real?: AudioNode;
  output: number;
  input: number;
  param?: string;
};

const recordedNodes = new WeakMap<object, Recorded>();

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
    public id: number,
    readonly kind: string,
    readonly options: Record<string, unknown>,
    private readonly budget?: Budget,
  ) {
    const names = PARAM_NAMES[kind] ?? [];
    for (const name of names) {
      const seeded = options[name];
      this.params[name] = new VirtualParam(
        typeof seeded === "number"
          ? seeded
          : name === "frequency" && kind === "BiquadFilterNode"
            ? 350
            : name === "gain" && kind === "BiquadFilterNode"
              ? 0
              : name === "offset"
                ? 1
                : (PARAM_DEFAULTS[name] ?? 0),
        budget,
      );
      this.params[name].owner = { node: this, name };
      const param = this.params[name];
      const exposed = new Proxy(param, {
        get(target, key) {
          budget?.assertActive?.();
          if (!(key in target))
            throw Error(`Unsupported audio parameter API: ${String(key)}.`);
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, key, value) {
          budget?.assertActive?.();
          if (key !== "value")
            throw Error(
              `Unsupported audio parameter property: ${String(key)}.`,
            );
          return Reflect.set(target, key, value, target);
        },
      });
      Object.defineProperty(this, name, {
        value: exposed,
        enumerable: true,
      });
    }
    if (options.buffer instanceof AudioBuffer) this.buffer = options.buffer;
    this.loop = options.loop === true;
    if (options.curve instanceof Float32Array) this.curve = options.curve;
  }
  get type() {
    return (
      this.options.type ?? (this.kind === "OscillatorNode" ? "sine" : "lowpass")
    );
  }
  set type(value: unknown) {
    this.options.type = value;
  }
  periodicWave: PeriodicWave | null = null;
  setPeriodicWave(wave: PeriodicWave) {
    this.periodicWave = wave;
  }
  get normalize() {
    return this.options.normalize ?? true;
  }
  set normalize(value: unknown) {
    this.options.normalize = value;
  }
  get oversample() {
    return this.options.oversample ?? "none";
  }
  set oversample(value: unknown) {
    this.options.oversample = value;
  }
  get loopStart() {
    return this.options.loopStart ?? 0;
  }
  set loopStart(value: unknown) {
    this.options.loopStart = value;
  }
  get loopEnd() {
    return this.options.loopEnd ?? 0;
  }
  set loopEnd(value: unknown) {
    this.options.loopEnd = value;
  }
  connect(
    destination: Recorded | AudioNode | VirtualParam,
    output = 0,
    input = 0,
  ) {
    this.budget?.assertActive?.();
    if (this.budget) count(this.budget, "edges", AUDIO_LIMITS.edges);
    if (destination instanceof VirtualParam) {
      if (!destination.owner)
        throw Error("Audio modulation target is unmanaged.");
      this.outs.push({
        node: destination.owner.node,
        output,
        input: 0,
        param: destination.owner.name,
      });
    } else if (destination instanceof Recorded)
      this.outs.push({
        node: recordedNodes.get(destination) ?? destination,
        output,
        input,
      });
    else {
      const real = this.budget?.destinations.get(destination);
      if (this.budget && !real)
        throw Error("Audio must connect to managed nodes or host.destination.");
      this.outs.push({ node: null, real: real ?? destination, output, input });
    }
    return destination;
  }
  disconnect() {
    this.outs.length = 0;
  }
  start(when: number, offset = 0, duration?: number) {
    finite(when, "source start", 0);
    finite(offset, "buffer offset", 0);
    if (duration != null) finite(duration, "buffer duration", 0);
    if (this.when != null) throw Error("Audio source can only start once.");
    this.when = when;
    this.offset = offset;
    this.playDuration = duration ?? null;
  }
  stop(when: number) {
    finite(when, "source stop", 0);
    this.until = when;
  }
}

/** Only this facade reaches author code; unsupported native APIs cannot bypass recording. */
function installRecorder(
  ctx: BaseAudioContext,
  bucket: Recorded[],
  budget: Budget,
) {
  const previous = new Map<string, unknown>();
  const root = globalThis as unknown as Record<string, unknown>;
  let active = true;
  const check = () => {
    if (!active)
      throw Error(
        "Audio scheduling has finished. Timers and retained hosts are unsupported.",
      );
  };
  budget.assertActive = check;
  const buffer = (value: AudioBuffer) => {
    if (!budget.buffers.has(value)) {
      budget.buffers.add(value);
      budget.bytes += value.length * value.numberOfChannels * 4;
      if (budget.bytes > AUDIO_LIMITS.sourceBufferBytes)
        throw Error("Audio source buffers exceed the 128 MiB limit.");
    }
    return value;
  };
  const curve = (value: unknown) => {
    if (value == null) return null;
    if (
      !(value instanceof Float32Array) ||
      value.length < 2 ||
      value.length > 65_536
    )
      throw Error("Audio curves need 2..65536 Float32 samples.");
    for (const sample of value) finite(sample, "curve value");
    budget.bytes += value.byteLength;
    if (budget.bytes > AUDIO_LIMITS.sourceBufferBytes)
      throw Error("Audio curves exceed the 128 MiB source budget.");
    return value.slice();
  };
  const make = (kind: string, options: Record<string, unknown> = {}) => {
    check();
    count(budget, "nodes", AUDIO_LIMITS.nodes);
    for (const [name, value] of Object.entries(options))
      if (typeof value === "number") finite(value, name);
    if (kind === "DelayNode") {
      const seconds = Number(options.maxDelayTime ?? 1);
      if (
        seconds <= 0 ||
        seconds > 30 ||
        (budget.delaySeconds += seconds) > AUDIO_LIMITS.delaySeconds
      )
        throw Error(
          "Audio delay storage exceeds its limit (30 s per node, 60 s total).",
        );
    }
    if (options.buffer instanceof AudioBuffer) buffer(options.buffer);
    if (options.curve != null)
      options = { ...options, curve: curve(options.curve) };
    const recorded = new Recorded(bucket.length, kind, { ...options }, budget);
    const proxy = new Proxy(recorded, {
      get(target, key, receiver) {
        check();
        if (key === "context") return facade;
        if (typeof key === "string" && !(key in target))
          throw Error(`Unsupported audio API: ${kind}.${key}.`);
        return Reflect.get(target, key, receiver);
      },
      set(target, key, value, receiver) {
        check();
        if (!(key in target))
          throw Error(`Unsupported audio property: ${kind}.${String(key)}.`);
        if (key === "buffer" && value instanceof AudioBuffer) buffer(value);
        if (key === "curve") value = curve(value);
        return Reflect.set(target, key, value, receiver);
      },
    });
    recordedNodes.set(proxy, recorded);
    bucket.push(recorded);
    return proxy;
  };
  const factories: Record<string, string> = {
    createOscillator: "OscillatorNode",
    createGain: "GainNode",
    createBiquadFilter: "BiquadFilterNode",
    createStereoPanner: "StereoPannerNode",
    createDelay: "DelayNode",
    createBufferSource: "AudioBufferSourceNode",
    createWaveShaper: "WaveShaperNode",
    createDynamicsCompressor: "DynamicsCompressorNode",
    createConstantSource: "ConstantSourceNode",
    createConvolver: "ConvolverNode",
  };
  const facade = new Proxy(ctx, {
    get(_target, key) {
      check();
      if (key === "sampleRate") return ctx.sampleRate;
      if (key === "currentTime") return 0;
      if (typeof key === "string" && factories[key])
        return (...args: number[]) =>
          make(
            factories[key],
            key === "createDelay" && args.length
              ? { maxDelayTime: args[0] }
              : {},
          );
      if (key === "createPeriodicWave") return ctx.createPeriodicWave.bind(ctx);
      if (key === "createBuffer")
        return (channels: number, length: number, rate: number) => {
          finite(channels, "channels", 1);
          finite(length, "buffer length", 1);
          finite(rate, "sample rate", 1);
          if (
            channels * length * 4 + budget.bytes >
            AUDIO_LIMITS.sourceBufferBytes
          )
            throw Error("Audio source buffers exceed the 128 MiB limit.");
          return buffer(ctx.createBuffer(channels, length, rate));
        };
      if (key === "decodeAudioData")
        return (bytes: ArrayBuffer, ...callbacks: unknown[]) => {
          if (callbacks.length)
            throw Error(
              "Use promise-based decodeAudioData and await it inside schedule.",
            );
          if (bytes.byteLength > AUDIO_LIMITS.sourceBufferBytes)
            throw Error("Encoded audio exceeds the 128 MiB asset limit.");
          budget.pendingDecodes++;
          const pending = ctx
            .decodeAudioData(bytes)
            .then((decoded) => {
              check();
              return buffer(decoded);
            })
            .finally(() => {
              budget.pendingDecodes--;
            });
          // The compiler rejects unawaited decode work explicitly; observe eventual
          // native completion too so an ignored author promise cannot leak a rejection.
          void pending.catch(() => {});
          return pending;
        };
      throw Error(
        `Unsupported audio context API: ${String(key)}. Use scheduled nodes and host.destination.`,
      );
    },
    set() {
      throw Error("The audio context is managed by Ritween.");
    },
  });
  for (const name of [
    ...CONSTRUCTORS,
    "ConvolverNode",
    "IIRFilterNode",
    "AnalyserNode",
    "PannerNode",
    "ChannelMergerNode",
    "ChannelSplitterNode",
    "AudioWorkletNode",
  ]) {
    const Original = root[name];
    if (typeof Original !== "function") continue;
    previous.set(name, Original);
    function Wrapped(
      this: unknown,
      context: BaseAudioContext,
      options?: Record<string, unknown>,
    ) {
      if (context === facade) {
        if (!(CONSTRUCTORS as readonly string[]).includes(name))
          throw Error(`Unsupported audio node: ${name}.`);
        return make(name, options);
      }
      return new (Original as new (...args: unknown[]) => unknown)(
        context,
        options,
      );
    }
    Wrapped.prototype = (Original as { prototype: object }).prototype;
    root[name] = Wrapped;
  }
  return {
    context: facade,
    restore() {
      active = false;
      for (const [name, Original] of previous) root[name] = Original;
    },
  };
}

type Voice = { ids: number[]; start: number; stop: number };

type ClipBus = {
  trackId: string;
  clipId: string;
  mute: GainNode;
  gain: AudioParam;
  start: number;
  duration: number;
  node: GainNode;
};

type Score = {
  audible: boolean;
  nodes: Recorded[];
  voices: Voice[];
  shared: number[];
  buses: ClipBus[];
};

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function toMixNode(node: Recorded): MixNode {
  return {
    id: node.id,
    kind: node.kind,
    start: node.when,
    stop: node.until,
    outs: node.outs.flatMap((edge) => (edge.node ? [edge.node.id] : [])),
  };
}

let recording = Promise.resolve();
async function recordScore(...args: Parameters<typeof recordScoreUnlocked>) {
  const previous = recording;
  let release!: () => void;
  recording = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await recordScoreUnlocked(...args);
  } finally {
    release();
  }
}

async function recordScoreUnlocked(
  ctx: BaseAudioContext,
  sum: AudioNode,
  project: Project,
  mutedTrackIds: readonly string[],
  signal?: AbortSignal,
  mutedClipIds: readonly string[] = [],
) {
  signal?.throwIfAborted();
  const mutedClips = new Set(mutedClipIds);
  const tracks = audibleAudioTracks(project, mutedTrackIds).filter((track) =>
    track.clips.some((clip) => !mutedClips.has(clip.id)),
  );
  const nodes: Recorded[] = [];
  const buses: ClipBus[] = [];
  if (!tracks.length)
    return {
      audible: false,
      nodes,
      voices: [],
      shared: [],
      buses,
    } satisfies Score;
  const RealGain = globalThis.GainNode;
  const budget: Budget = {
    nodes: 2,
    edges: 0,
    events: 0,
    bytes: 0,
    delaySeconds: 0,
    buffers: new WeakSet(),
    destinations: new WeakMap(),
    pendingDecodes: 0,
  };
  const recorder = installRecorder(ctx, nodes, budget);
  try {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (mutedClips.has(clip.id)) continue;
        await recordClip(
          ctx,
          recorder.context,
          sum,
          track.id,
          clip,
          nodes,
          buses,
          RealGain,
          budget,
          signal,
        );
      }
    }
    const grouped = groupVoices(nodes.map(toMixNode));
    return {
      audible: true,
      nodes,
      voices: grouped.voices,
      shared: grouped.shared,
      buses,
    } satisfies Score;
  } catch (error) {
    for (const bus of buses) {
      bus.node.disconnect();
      bus.mute.disconnect();
    }
    throw error;
  } finally {
    recorder.restore();
  }
}

async function recordClip(
  ctx: BaseAudioContext,
  authorContext: BaseAudioContext,
  sum: AudioNode,
  trackId: string,
  clip: AudioClip,
  nodes: Recorded[],
  buses: ClipBus[],
  RealGain: typeof GainNode,
  budget: Budget,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const before = nodes.length;
  count(budget, "nodes", AUDIO_LIMITS.nodes);
  const bus = new RealGain(ctx, { gain: 0 });
  count(budget, "nodes", AUDIO_LIMITS.nodes);
  const mute = new RealGain(ctx, { gain: 1 });
  bus.connect(mute).connect(sum);
  buses.push({
    trackId,
    clipId: clip.id,
    mute,
    gain: bus.gain,
    start: clip.start,
    duration: clip.duration,
    node: bus,
  });
  const destination = new Proxy(bus, {
    get(_target, key) {
      if (key === "context") return authorContext;
      throw Error(
        "host.destination is a connection target; create a managed GainNode to control a bus.",
      );
    },
    set() {
      throw Error("host.destination is managed by Ritween.");
    },
  });
  budget.destinations.set(destination, bus);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(Error("Audio scheduling timed out after 30 seconds.")),
      AUDIO_LIMITS.scheduleTimeoutMs,
    );
    abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([
      clip.create().schedule({
        context: authorContext,
        signal,
        destination,
        start: clip.start,
        duration: clip.duration,
        at: (localTime) => clip.start + localTime,
      }),
      stopped,
    ]);
    if (budget.pendingDecodes)
      throw Error("Await decodeAudioData before schedule returns.");
  } catch (error) {
    signal?.throwIfAborted();
    throw Error(
      `Audio clip "${clip.id}": ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
  for (const node of nodes.slice(before)) {
    if (node.when == null) continue;
    if (node.until == null) node.until = clip.start + clip.duration;
    const end = node.until;
    if (end < clip.start || node.when > clip.start + clip.duration)
      node.when = null;
  }
}

function createReal(ctx: BaseAudioContext, node: Recorded) {
  const options = { ...node.options };
  if (node.kind === "OscillatorNode") {
    const source = new OscillatorNode(ctx, options as OscillatorOptions);
    if (node.periodicWave) source.setPeriodicWave(node.periodicWave);
    return source;
  }
  if (node.kind === "GainNode")
    return new GainNode(ctx, options as GainOptions);
  if (node.kind === "BiquadFilterNode")
    return new BiquadFilterNode(ctx, options as BiquadFilterOptions);
  if (node.kind === "StereoPannerNode")
    return new StereoPannerNode(ctx, options as StereoPannerOptions);
  if (node.kind === "DelayNode")
    return new DelayNode(ctx, options as DelayOptions);
  if (node.kind === "ConvolverNode")
    return new ConvolverNode(ctx, {
      ...options,
      buffer: node.buffer,
    } as ConvolverOptions);
  if (node.kind === "WaveShaperNode") {
    const shaper = new WaveShaperNode(ctx, options as WaveShaperOptions);
    if (node.curve) shaper.curve = new Float32Array(node.curve);
    return shaper;
  }
  if (node.kind === "DynamicsCompressorNode")
    return new DynamicsCompressorNode(
      ctx,
      options as DynamicsCompressorOptions,
    );
  if (node.kind === "ConstantSourceNode")
    return new ConstantSourceNode(ctx, options as ConstantSourceOptions);
  const source = new AudioBufferSourceNode(ctx, {
    buffer: node.buffer,
    loop: node.loop,
    loopStart: Number(node.options.loopStart ?? 0),
    loopEnd: Number(node.options.loopEnd ?? 0),
    playbackRate:
      typeof options.playbackRate === "number"
        ? options.playbackRate
        : undefined,
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
    .filter(
      (event) =>
        event.time > compositionNow + 1e-4 && origin + event.time >= audioNow,
    )
    .sort((a, b) => a.time - b.time);
  let value = valueAt(recorded.initial, recorded.events, compositionNow);
  if (future[0]?.op === "expo" && value <= 0) value = 1e-4;
  const hold = Math.max(audioNow, origin + compositionNow);
  param.cancelScheduledValues(audioNow);
  param.setValueAtTime(value, hold);
  const past = recorded.events
    .filter((event) => event.time <= compositionNow)
    .sort((a, b) => a.time - b.time);
  const active = past.at(-1);
  if (active?.op === "target")
    param.setTargetAtTime(active.value, hold, active.constant);
  if (
    active?.op === "curve" &&
    compositionNow < active.time + active.duration
  ) {
    // Resume a curve at the held value; remaining sample points preserve its
    // piecewise-linear shape even when preview begins in the middle of it.
    for (let i = 1; i < active.values.length; i++) {
      const when =
        origin +
        active.time +
        (active.duration * i) / (active.values.length - 1);
      if (when > hold) param.linearRampToValueAtTime(active.values[i], when);
    }
  }
  for (const event of future) {
    const when = origin + event.time;
    if (when <= hold + 1e-4) continue;
    if (event.op === "set") param.setValueAtTime(event.value, when);
    else if (event.op === "linear")
      param.linearRampToValueAtTime(event.value, when);
    else if (event.op === "expo")
      param.exponentialRampToValueAtTime(Math.max(1e-4, event.value), when);
    else if (event.op === "target")
      param.setTargetAtTime(event.value, when, event.constant);
    else param.setValueCurveAtTime(event.values, when, event.duration);
  }
}

function connectEdges(node: Recorded, live: Map<number, AudioNode>) {
  const source = live.get(node.id);
  if (!source) return;
  for (const edge of node.outs) {
    const destination = edge.node ? live.get(edge.node.id) : edge.real;
    if (!destination) continue;
    try {
      if (edge.param)
        source.connect(
          (destination as unknown as Record<string, AudioParam>)[edge.param],
          edge.output,
        );
      else source.connect(destination, edge.output, edge.input);
    } catch {
      /* A feedback edge is connected once. */
    }
  }
}

/** Compile authored Web Audio once; automatically defer native voice subgraphs. */
export async function prepareOfflineAudio(
  ctx: OfflineAudioContext,
  sum: AudioNode,
  project: Project,
  mutedTrackIds: readonly string[],
  signal?: AbortSignal,
  mutedClipIds: readonly string[] = [],
) {
  signal?.throwIfAborted();
  const score = await recordScore(
    ctx,
    sum,
    project,
    mutedTrackIds,
    signal,
    mutedClipIds,
  );
  signal?.throwIfAborted();
  const live = new Map<number, AudioNode>();
  const materialize = (ids: readonly number[]) => {
    signal?.throwIfAborted();
    for (const id of ids) live.set(id, createReal(ctx, score.nodes[id]));
    for (const id of ids) {
      const node = score.nodes[id],
        real = live.get(id)!;
      for (const [name, recorded] of Object.entries(node.params)) {
        const param = (real as unknown as Record<string, AudioParam>)[name];
        param.value = recorded.originalInitial;
        for (const event of recorded.operations) {
          if (event.op === "cancel") param.cancelScheduledValues(event.time);
          else if (event.op === "hold") param.cancelAndHoldAtTime(event.time);
          else if (event.op === "set")
            param.setValueAtTime(event.value, event.time);
          else if (event.op === "linear")
            param.linearRampToValueAtTime(event.value, event.time);
          else if (event.op === "expo")
            param.exponentialRampToValueAtTime(event.value, event.time);
          else if (event.op === "target")
            param.setTargetAtTime(event.value, event.time, event.constant);
          else if (event.op === "curve")
            param.setValueCurveAtTime(event.values, event.time, event.duration);
        }
      }
      if (node.when != null && "start" in real) {
        const source = real as AudioBufferSourceNode;
        if (node.kind === "AudioBufferSourceNode") {
          if (node.playDuration != null)
            source.start(node.when, node.offset, node.playDuration);
          else source.start(node.when, node.offset);
        } else source.start(node.when);
        source.stop(node.until!);
      }
    }
    // Connect only newly available edges, including shared-to-voice routing.
    for (const node of score.nodes) {
      const source = live.get(node.id);
      if (!source) continue;
      for (const edge of node.outs) {
        if (connected.has(edge)) continue;
        const destination = edge.node ? live.get(edge.node.id) : edge.real;
        if (!destination) continue;
        if (edge.param)
          source.connect(
            (destination as unknown as Record<string, AudioParam>)[edge.param],
            edge.output,
          );
        else source.connect(destination, edge.output, edge.input);
        connected.add(edge);
      }
    }
  };
  const connected = new Set<Edge>();
  // Clip windows retain the original full-mix envelope, independent of voices.
  for (const bus of score.buses) {
    const start = bus.start,
      end = start + bus.duration,
      ramp = Math.min(0.005, bus.duration / 2);
    bus.gain.setValueAtTime(0, start);
    bus.gain.linearRampToValueAtTime(1, start + ramp);
    if (end - ramp > start + ramp) bus.gain.setValueAtTime(1, end - ramp);
    bus.gain.linearRampToValueAtTime(0, end);
  }
  materialize(score.shared);
  return score.voices
    .sort((a, b) => a.start - b.start)
    .map((voice) => ({
      time: voice.start,
      schedule: () => materialize(voice.ids),
    }));
}

/**
 * Preview mix. The score is recorded once, then only the notes inside the
 * lookahead exist as real nodes. Export reuses the same graph compiler with an offline clock.
 */
export class LiveMix {
  private score: Score | null = null;
  private project: Project | null = null;
  private preparation: Promise<boolean> | null = null;
  private preparationAbort: AbortController | null = null;
  private disposed = false;
  private preparedClipIds = new Set<string>();
  private mutedTracks = new Set<string>();
  private mutedClips = new Set<string>();
  private origin = 0;
  private startOffset = 0;
  private nextVoice = 0;
  private playing = false;
  private timer = 0;
  private liveVoices: { stop: number; nodes: AudioNode[] }[] = [];
  private sharedNodes = new Map<number, AudioNode>();
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

  prepare(
    project: Project,
    mutedTrackIds: readonly string[],
    mutedClipIds: readonly string[] = [],
  ) {
    if (this.disposed)
      return Promise.reject(Error("Preview audio is disposed."));
    validateProject(project);
    const sameAudio =
      this.project?.audioTracks === project.audioTracks &&
      this.project?.duration === project.duration;
    const nextMutedTracks = new Set([
      ...mutedAudioTrackIds(project),
      ...mutedTrackIds,
    ]);
    const nextMutedClips = new Set([
      ...mutedAudioClipIds(project),
      ...mutedClipIds,
    ]);
    const sameMuteState =
      sameSet(this.mutedTracks, nextMutedTracks) &&
      sameSet(this.mutedClips, nextMutedClips);
    if (!sameAudio) {
      this.stop();
      this.preparationAbort?.abort();
      this.preparation = null;
      this.dropBuses();
      this.score = null;
      this.preparedClipIds.clear();
      this.project = project;
      this.preparationAbort = new AbortController();
    } else {
      this.project = project;
    }
    this.applyMuteState([...nextMutedTracks], [...nextMutedClips]);
    // Preserve promise identity for callers racing the same preparation. A later
    // unmute starts a separate lazy batch, so its errors do not block picture setup.
    if (sameAudio) {
      if (this.preparation && sameMuteState) return this.preparation;
      return this.ensurePrepared();
    }
    return this.prepareMissingBatch();
  }

  setMuted(trackIds: readonly string[], clipIds: readonly string[] = []) {
    this.applyMuteState(trackIds, clipIds);
    return this.ensurePrepared().then(() => {});
  }

  private applyMuteState(
    trackIds: readonly string[],
    clipIds: readonly string[],
  ) {
    this.mutedTracks = new Set(trackIds);
    this.mutedClips = new Set(clipIds);
    for (const bus of this.score?.buses ?? []) {
      const value =
        this.mutedTracks.has(bus.trackId) || this.mutedClips.has(bus.clipId)
          ? 0
          : 1;
      bus.mute.gain.setTargetAtTime(value, this.ctx.currentTime, 0.005);
    }
  }

  private ensurePrepared(): Promise<boolean> {
    if (this.disposed)
      return Promise.reject(Error("Preview audio is disposed."));
    if (this.preparation)
      return this.preparation.then(() => this.ensurePrepared());
    return this.prepareMissingBatch();
  }

  private prepareMissingBatch(): Promise<boolean> {
    const project = this.project;
    const controller = this.preparationAbort;
    if (!project || !controller) return Promise.resolve(false);
    const selected = new Set<string>();
    for (const track of project.audioTracks ?? []) {
      if (this.mutedTracks.has(track.id)) continue;
      for (const clip of track.clips)
        if (!this.mutedClips.has(clip.id) && !this.preparedClipIds.has(clip.id))
          selected.add(clip.id);
    }
    if (!selected.size) return Promise.resolve(this.score?.audible ?? false);

    const audioTracks = (project.audioTracks ?? []).flatMap((track) => {
      const clips = track.clips.filter((clip) => selected.has(clip.id));
      return clips.length ? [{ ...track, clips }] : [];
    });
    const batchProject = { ...project, settings: undefined, audioTracks };
    const pending = recordScore(
      this.ctx,
      this.sum,
      batchProject,
      [],
      controller.signal,
    )
      .then((score) => {
        if (controller.signal.aborted) {
          for (const bus of score.buses) {
            bus.node.disconnect();
            bus.mute.disconnect();
          }
          controller.signal.throwIfAborted();
        }
        for (const clipId of selected) this.preparedClipIds.add(clipId);
        this.appendScore(score);
        if (this.playing && score.audible) {
          const now = Math.max(
            this.startOffset,
            this.ctx.currentTime - this.origin,
          );
          this.rebuild(now);
        }
        return this.score?.audible ?? false;
      })
      .finally(() => {
        if (this.preparation === pending) this.preparation = null;
      });
    this.preparation = pending;
    return pending;
  }

  private appendScore(incoming: Score) {
    const current =
      this.score ??
      ({
        audible: false,
        nodes: [],
        voices: [],
        shared: [],
        buses: [],
      } satisfies Score);
    const offset = current.nodes.length;
    for (let index = 0; index < incoming.nodes.length; index++)
      incoming.nodes[index].id = offset + index;
    const nodes = [...current.nodes, ...incoming.nodes];
    const grouped = groupVoices(nodes.map(toMixNode));
    this.score = {
      audible: current.audible || incoming.audible,
      nodes,
      voices: grouped.voices.sort((a, b) => a.start - b.start),
      shared: grouped.shared,
      buses: [...current.buses, ...incoming.buses],
    };
    this.applyMuteState([...this.mutedTracks], [...this.mutedClips]);
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
    return Math.max(
      this.startOffset,
      this.ctx.currentTime - this.origin - latency,
    );
  }

  stop() {
    this.playing = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.releaseRendered(this.ctx.currentTime);
  }

  dispose() {
    this.disposed = true;
    this.preparationAbort?.abort();
    this.stop();
    this.dropBuses();
    this.score = null;
    this.project = null;
    this.sum.disconnect();
    this.limiter.disconnect();
  }

  private rebuild(from: number) {
    this.releaseRendered(this.ctx.currentTime);
    this.startOffset = from;
    this.nextVoice = 0;
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
      this.sharedNodes.set(id, real);
    }
    for (const id of this.score.shared)
      connectEdges(this.score.nodes[id], live);
    const audioNow = this.ctx.currentTime;
    for (const id of this.score.shared) {
      const node = this.score.nodes[id];
      const real = live.get(id);
      if (!node || !real) continue;
      this.automate(node, real, from, audioNow);
      this.startIfScheduled(node, real, audioNow);
    }
  }

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
    // Each future voice is visited once per playback/seek, rather than scanning
    // every note in the entire composition on every timer callback.
    while (this.nextVoice < this.score.voices.length) {
      const voice = this.score.voices[this.nextVoice];
      if (voice.start > horizon) break;
      this.nextVoice++;
      if (voice.stop < compositionNow - RELEASE_SECONDS) continue;
      this.liveVoices.push(this.materialize(voice, compositionNow, audioNow));
    }
  }

  private materialize(voice: Voice, compositionNow: number, audioNow: number) {
    const live = new Map(this.sharedNodes);
    const created: AudioNode[] = [];
    for (const id of voice.ids) {
      const node = this.score!.nodes[id];
      const real = createReal(this.ctx, node);
      live.set(id, real);
      created.push(real);
    }
    for (const id of voice.ids) connectEdges(this.score!.nodes[id], live);
    for (const id of this.score!.shared)
      connectEdges(this.score!.nodes[id], live);
    for (let index = 0; index < voice.ids.length; index++) {
      const node = this.score!.nodes[voice.ids[index]];
      const real = created[index];
      this.automate(
        node,
        real,
        Math.max(compositionNow, voice.start),
        audioNow,
      );
      this.startIfScheduled(node, real, audioNow);
    }
    return { stop: voice.stop, nodes: created };
  }

  private automate(
    node: Recorded,
    real: AudioNode,
    compositionNow: number,
    audioNow: number,
  ) {
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
        const duration =
          node.playDuration == null
            ? undefined
            : Math.max(0.01, node.playDuration - late);
        const loopEnd = source.loopEnd || source.buffer?.duration || 0;
        const offset = source.loop
          ? offsetAfterElapsed(node.offset, late, source.loopStart, loopEnd)
          : node.offset + late;
        if (duration == null) source.start(when, offset);
        else source.start(when, offset, duration);
      } else source.start(when);
      source.stop(Math.max(end, when + 0.01));
    } catch {
      /* Already started, or the note ended inside this window. */
    }
  }

  private armBuses(from: number) {
    if (!this.score) return;
    const audioNow = this.ctx.currentTime;
    for (const bus of this.score.buses)
      armBus(bus, this.origin, from, audioNow);
  }

  private releaseRendered(audioNow: number) {
    for (const voice of this.liveVoices) {
      for (const node of voice.nodes) silence(node, audioNow);
    }
    for (const node of this.sharedNodes.values()) silence(node, audioNow);
    this.liveVoices = [];
    this.sharedNodes.clear();
  }

  private dropBuses() {
    for (const bus of this.score?.buses ?? []) {
      bus.node.disconnect();
      bus.mute.disconnect();
    }
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
