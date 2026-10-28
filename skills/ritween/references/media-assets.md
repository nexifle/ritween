# Local audio, image, and video assets

Use assets supplied by the user. Do not replace footage/images with procedural visuals or BGM/SFX with synthesis without their approval. These APIs require a Ritween version that exports them; inspect the installed package types before using the examples.

## File locations

Place files in the consumer project's `public/` directory. Access `public/media/shot.mp4` as `/media/shot.mp4`, not `/public/media/shot.mp4` or a filesystem path such as `/Users/...`. Media helpers use same-origin URLs and do not provide uploads or arbitrary filesystem access.

## Ready-made scenes

```ts
import { imageScene, videoClip, audioFile, type Project } from "ritween";

export const project: Project = {
  name: "Footage and images",
  resolution: [1280, 720],
  aspectRatio: [16, 9],
  duration: 8,
  scenes: [
    videoClip({
      id: "opening",
      name: "Opening",
      source: "manifest.ts",
      url: "/media/shot.mp4",
      start: 0,
      trim: { in: 2, out: 7 },
      fit: "cover",
      audio: { muted: false },
    }),
    imageScene({
      id: "closing",
      name: "Closing",
      source: "manifest.ts",
      url: "/media/logo.png",
      start: 5,
      duration: 3,
      fit: "contain",
      transform: ({ localTime }) => ({
        x: 640,
        y: 360,
        width: 600,
        height: 400,
        rotation: localTime * 0.1,
        opacity: Math.min(1, localTime / 0.3),
      }),
    }),
  ],
  audioTracks: [
    {
      id: "music",
      name: "Music",
      clips: [
        {
          id: "bgm",
          name: "BGM",
          start: 0,
          duration: 8,
          create: audioFile({ url: "/media/music.wav", volume: 0.25 }),
        },
      ],
    },
  ],
};
```

Times are in seconds. The trim interval `[in, out)` determines video duration; do not declare a second, conflicting duration. Transforms use composition pixels, object-center `x/y`, rotation in radians, and opacity from 0 to 1. `contain` preserves the entire image; `cover` fills the box by cropping. Derive animation from timeline time, not previous-frame state.

Footage audio is derived automatically with the same video clip ID. The studio displays it as a linked audio clip with a mute control; muting does not remove the picture. `settings.audioClips[id].muted` overrides the default `audio.muted`, including an explicit `false`. Studio changes are saved to the project's sidecar and apply to export. Track mute remains an additional gate; monitor/master mute affects preview only.

## Resources for custom WebGPU scenes

Use `videoResource` as an immutable descriptor and register it in `project.mediaClips` or `scene.mediaClips`. A scene may use multiple videos; give each usage its own ID so its audio can be controlled independently.

```ts
const footage = videoResource({
  id: "screen-video",
  name: "Screen video",
  url: "/media/shot.mp4",
  start: 0,
  duration: 5,
  offset: 2,
  muted: false,
});
```

Within the scene:

1. `setup`: call `loadVideoTexture(context, footage)` and/or `loadImageTexture(context, { url })`, then prepare the scene's samplers, bind groups, and pipelines.
2. `prepareFrame`: await `video.prepareFrame({ time: context.time, signal: context.signal })`. The resource uses **composition time**, not `localTime`, to map `start` and `offset`.
3. `render`: sample `resource.texture` in a shader. The scene determines placement, 3D geometry, masks, effects, and compositing. The engine submits the command encoder.
4. `dispose`: call `dispose()` on every resource and destroy scene-owned GPU resources.

Do not share video resource instances across renderers/devices. Registering descriptors only supplies audio; the scene must still load and draw the texture to produce visuals. Use a custom scene for multiple textures rather than stacking full-screen scene helpers.

Scenes with asynchronous preparation must use `Renderer.renderAsync()` or `FrameSource.render()`, not synchronous `Renderer.render()`. Preview and CLI provide the asynchronous path.

## Loading mode and budgets

The CLI defaults to full-resource loading. Where supported by installed CLI help,
`--media-loading range` enables bounded HTTP Range loading for imported MP4 video
and linked AAC across preview, frame, and export. Standalone `audioFile` loading
is unchanged. Use the [CLI examples and verification steps](preview-export.md#imported-mp4-loading)
rather than an internal global or a made-up manifest option.

Range mode probes up to 512 KiB, skips `mdat` while locating metadata, and supports
leading or trailing `moov`. Small files may arrive entirely in the probe.
Incremental reads require a strong ETag and validated partial responses; servers
without suitable support use a bounded full-resource fallback. The CLI server
provides Range responses and strong ETags for public MP4 assets; do not assume
another server has the same behavior.

Encoded blocks use a shared 8 MiB LRU with 256 KiB blocks. Shared full fallbacks
are limited to 128 MiB in total, with at most 16 distinct active byte sources.
Each individual range/sample and each `moov` is limited to 4 MiB. The scanner is
limited to 4,096 top-level boxes. These limits can reject an asset that fits the
per-asset size limit; Range does not expand supported formats or large-file limits.

Consumers of the same URL can share encoded bytes and parsed metadata, not
decoder state or GPU textures. Cancelling or disposing one consumer does not
invalidate another; the last owner releases the source cache. Dispose each
resource normally rather than attempting to manage the internal shared cache.
The encoded-cache budget excludes caller-owned copies, metadata, in-flight
buffers, native decoder memory, PCM, and GPU resources. It is not a total RAM cap.

## Format limits and validation

No third-party media decoder dependency is required. Video input uses the internal MP4 reader and browser WebCodecs; the supported input targets non-fragmented H.264 MP4 with optional AAC. This does not guarantee every MP4 can be read. Encrypted files, unsupported structures, and unavailable codecs must produce explicit errors.

The reader accepts at most one H.264 `avc1` track and one AAC-LC `mp4a.40.2` track, each with one sample description. Edit lists are limited to one rate-1 media edit with an optional leading empty edit. Fragmented MP4, encryption, track rotation/transforms, non-square pixel aspect, clean aperture, and other unsupported structures are explicitly rejected. Normalize such assets outside Ritween before use.

Files without audio must still display. Do not assume AAC is available merely because H.264 video decodes. Standalone audio files use browser decoding through the managed audio context; available formats depend on the browser.

Resource limits:

- Encoded assets are limited to **128 MiB each**; URLs must be HTTP(S), same-origin, with no redirects.
- Source PCM is limited to **128 MiB**, and the offline stereo mix to **256 MiB**.
- Media textures are limited to **64 MiB total per GPUDevice**, not per clip. The renderer prepares all scenes eagerly, so textures from inactive scenes also consume this budget. The same file used by separate resources has separate textures.
- Texture dimensions remain device-limited; video decoding supports at most 2,048 samples per GOP.

Split the project or reduce asset resolution when a limit is exceeded. Do not promise unlimited footage duration or asset counts.

Inspect frames before/after cuts, forward/backward seeks within the same renderer, image transforms, visual/audio marker synchronization, mute/unmute and settings reload, then decode the exported MP4. A PNG does not prove audio; a build does not prove browser decoding or export. Report the formats and cases actually tested.
