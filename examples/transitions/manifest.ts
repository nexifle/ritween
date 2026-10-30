import {
  Box,
  Shot,
  Text,
  World,
  ZStack,
  type AudioClip,
  type Project,
  type Transition,
} from "../../src/index";

const duration = 2;
const transitions: Transition[] = [
  { type: "cut" },
  { type: "shared", duration: 1 },
  {
    type: "custom",
    duration: 1,
    shader: `
    fn transition(uv: vec2f, progress: f32) -> vec4f {
      let a = textureSample(outgoing, samp, uv);
      let b = textureSample(incoming, samp, uv);
      return mix(a, b, smoothstep(0., 1., progress));
    }
  `,
  },
];
const scenes = transitions.map((transition, index) =>
  Shot({
    id: `shot-${index}`,
    source: "manifest.ts",
    start: index,
    duration,
    designSize: [960, 540],
    background: "#101827",
    transition,
    world: World(
      () =>
        ZStack(
          [
            Box({
              width: 160 + index * 40,
              height: 160,
              radius: 24,
              fill: index === 2 ? "#FAAD45" : "#4268EC",
            })
              .id("hero")
              .offset(index * 240 + 40, 180),
            Text(
              [
                "Shared element: left",
                "Same element: right",
                "Custom WGSL fade",
              ][index],
              { color: "#FFFFFF", size: 36 },
            ).offset(40, 40),
          ],
          { align: "start" },
        ),
      { size: [960, 540] },
    ),
  }),
);
const clips: AudioClip[] = scenes.map((scene, index) => ({
  id: `tone-${index}`,
  name: scene.id,
  sceneId: scene.id,
  start: scene.start,
  duration: scene.duration,
  create: () => ({
    schedule(host) {
      const source = new OscillatorNode(host.context, {
        frequency: 220 + index * 110,
      });
      const gain = new GainNode(host.context, { gain: 0.08 });
      source.connect(gain).connect(host.destination);
      source.start(host.at(0));
      source.stop(host.at(host.duration));
    },
  }),
}));
export const project: Project = {
  name: "Shared elements, WGSL and audio crossfades",
  resolution: [960, 540],
  aspectRatio: [16, 9],
  duration: 4,
  scenes,
  audioTracks: clips.map((clip) => ({
    id: clip.id,
    name: clip.name,
    clips: [clip],
  })),
};
