<div align="center">

# Ritween

**Write scenes. Preview instantly. Export video.**

A code-first video framework powered by WebGPU and native browser codecs.

[Website](https://ritween.nexifle.com) · [Quick start](#quick-start) · [AI skill](#ai-coding-skill) · [CLI guide](CLI.md) · [Technical guide](docs/technical-guide.md)

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![WebGPU](https://img.shields.io/badge/rendering-WebGPU-005A9C)](https://gpuweb.github.io/gpuweb/)
[![Publish to npm](https://github.com/nexifle/ritween/actions/workflows/publish.yml/badge.svg)](https://github.com/nexifle/ritween/actions/workflows/publish.yml)
[![CI](https://github.com/nexifle/ritween/actions/workflows/ci.yml/badge.svg)](https://github.com/nexifle/ritween/actions/workflows/ci.yml)

**Engineered by [Nexifle Lab](https://nexifle.com).**

</div>

---

Ritween turns source code into video. Define a composition in a manifest, write scenes in TypeScript or JavaScript, and use the browser studio to preview, seek, and export the result. The same engine powers the studio, CLI, and programmatic API.

Built for developers and workflows where external AI coding agents author scene modules, Ritween keeps composition logic in version control. Rendering uses WebGPU; MP4 export uses WebCodecs and a custom muxer, without a backend rendering service, FFmpeg, or DOM capture.

## Highlights

- **Code-first compositions** — describe scene timing, resolution, and audio tracks in a project manifest.
- **GPU rendering** — create procedural visuals with WebGPU and WGSL shaders.
- **Interactive studio** — preview playback, seek through scenes, inspect source, and configure exports.
- **Native MP4 export** — encode H.264 video with an optional AAC soundtrack and fast-start metadata.
- **Shared timeline** — preview and export evaluate scenes at absolute times, with export frames scheduled at `frameIndex / FPS`.
- **Audio tracks** — schedule clips independently of scenes and persist track mute settings with the project.
- **Automation** — render PNG frames or export complete videos through the CLI, including JSON output for scripts.

## Quick start

### Requirements

- Node.js **22.18.0+**.
- A current Chrome or Edge with **WebGPU**, **WebCodecs H.264 encoding**, and GPU acceleration. Audio export also requires AAC encoding support.
- **HTTPS or localhost** for WebGPU. The CLI requires a separately installed compatible browser; it does not download one.

### Install

Install Ritween globally from npm:

```sh
npm install -g ritween
```

Open the bundled demo in the browser studio:

```sh
ritween preview --demo --open
```

Preview your own project by pointing Ritween to its directory or manifest:

```sh
ritween preview --project /path/to/project --open
```

The CLI prints the local studio URL. Scene, helper, manifest, and project-settings edits update the preview without reloading the studio, preserving the playhead and view controls. Invalid updates keep the last working preview until the code is fixed; updates received during export are applied after it finishes.

Visit **[ritween.nexifle.com](https://ritween.nexifle.com)** for the Ritween website.

## AI coding skill

The optional [Ritween skill](skills/ritween/SKILL.md) teaches compatible coding agents to author videos using the public Ritween API and CLI. It covers brief development, art direction, storyboard and motion choreography, WebGPU scenes, audio, preview checks, and export. Specialized references are loaded only when needed.

### Install the skill

Install the Ritween CLI separately if you have not already:

```sh
npm install -g ritween
```

Then run the [Skills CLI](https://github.com/vercel-labs/skills) from your video project's directory:

```sh
npx skills add nexifle/ritween --skill ritween
```

Choose your coding agent when prompted. Installation is project-scoped by default. Add `-g` to make the skill available across projects:

```sh
npx skills add nexifle/ritween --skill ritween -g
```

The Skills CLI has its own Node.js requirement; its current documentation requires **Node.js 22.20+**. Installing the skill supplies agent instructions, not the Ritween executable, a browser, or a video project. You do not need a Ritween framework checkout. For agents with manual skill installation, copy the complete [`skills/ritween/`](skills/ritween/) directory—including `references/` and `assets/`—into the agent's documented skill location.

### Use the skill

Open your video project in the agent where you installed the skill. Mention Ritween and describe the message, audience, duration, format, visual direction, and audio requirements. Agents that support automatic skill selection can load it from that context; otherwise explicitly ask the agent to use the `ritween` skill. Invocation syntax varies by agent.

For example:

```text
Use the ritween skill to create a 15-second, 16:9 motion-graphics video
introducing a task-planning app. Use clean typography, coordinated shape
animation, and readable text—not a slideshow or shader showcase. Include
subtle procedural sound effects, no voiceover. Develop a short beat sheet,
create the runnable project, inspect preview playback and seeking, and
export to artifacts/task-planner.mp4. Report any checks you could not run.
```

For an existing project:

```text
Use the ritween skill to improve the motion in ./manifest.ts. Preserve the
copy, palette, and duration. Make the transitions feel connected without
adding overlapping scene entries. Check backward seeking and export to
a fresh output path without replacing existing files.
```

The skill guides the agent; it does not render video by itself. Preview and export still require the [browser and GPU capabilities](#requirements) listed above. Review generated code and output, and distinguish inspected still frames from verified playback and audio. The skill is for creating videos, not developing Ritween's framework internals.

## Author a composition

The bundled project is an eight-second composition with three scenes and two audio tracks. Start with:

| File                                                 | Purpose                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| [`src/project/manifest.ts`](src/project/manifest.ts) | Composition name, dimensions, scene timing, and audio tracks |
| [`src/project/scenes/`](src/project/scenes/)         | Scene factories and GPU rendering code                       |
| [`src/project/audio/`](src/project/audio/)           | Procedural audio sources                                     |
| [`src/engine/types.ts`](src/engine/types.ts)         | Public scene, project, and audio contracts                   |

Each scene implements three lifecycle methods:

```ts
import type { Scene } from "ritween";

export default function createScene(): Scene {
  return {
    setup({ device, format, resolution }) {
      // Create GPU resources and render pipelines.
    },
    render({ encoder, target, localTime, progress }) {
      // Encode GPU commands for this absolute timeline position.
    },
    dispose() {
      // Release resources owned by this scene.
    },
  };
}
```

This is a lifecycle outline; use the bundled scenes for complete rendering implementations. Rendering must be synchronous and seekable: derive animation from timeline time rather than accumulated frame deltas. Each renderer owns its own scene instances and GPU resources.

Scene modules execute as application code. Use trusted source modules. TSX files are supported as modules; JSX is not automatically converted into GPU graphics.

## Aset media lokal

Ritween menyediakan helper `audioFile`, `imageScene`, dan `videoClip`, serta `loadImageTexture`, `videoResource`, dan `loadVideoTexture` untuk custom scene WebGPU. Letakkan file dalam `public/` proyek: `public/media/shot.mp4` diakses sebagai `/media/shot.mp4`.

```ts
videoClip({
  id: "opening",
  name: "Opening",
  source: "manifest.ts",
  url: "/media/shot.mp4",
  start: 0,
  trim: { in: 2, out: 7 },
  fit: "cover",
  audio: { muted: false },
});
```

Helper tersebut menghasilkan scene lima detik dan audio footage terkait. Mute per clip dapat diatur melalui kode dan studio; override `settings.audioClips[id].muted` tersimpan pada sidecar serta digunakan saat export. Gambar tetap tampil saat audio di-mute.

Untuk beberapa gambar/video, posisi 2D/3D, mask, atau shader khusus, gunakan resource texture dalam scene sendiri. Daftarkan descriptor video di `project.mediaClips` atau `scene.mediaClips` untuk audio terkait. Scene dengan `prepareFrame` asinkron menggunakan `Renderer.renderAsync`; `render` tetap sinkron.

Input video memakai pembaca MP4 internal dan WebCodecs browser, tanpa dependency media pihak ketiga. MP4 non-fragmented mendukung H.264 (`avc1`/`avc3`), HEVC/H.265 (`hvc1`/`hev1`), dan AV1 (`av01`), dengan AAC-LC opsional. Parser juga menerima compact sample table `stz2`, metadata dependensi `sdtp`, serta sample groups AAC `roll`/`prol` dengan dependensi mundur, termasuk keluaran FFmpeg yang umum. Kemampuan decode mengikuti browser/perangkat; fragmented MP4, enkripsi, rotasi track, dan struktur yang belum didukung tetap ditolak eksplisit. Ekspor tetap H.264/AAC. Lihat [panduan aset media](skills/ritween/references/media-assets.md) untuk contoh lengkap dan batas validasi.

## Use the studio

1. Edit the manifest and scene modules.
2. Press **Space** to play or pause. Use the scrubber to seek and the arrow keys to step through frames.
3. Choose an export size, **24, 30, or 60 FPS**, and automatic or explicit bitrate.
4. Select **Export Video** to encode and download the composition as MP4.

Export sizes preserve the project aspect ratio, using an even frame size with a short side of 360, 720, or 1080 where supported by H.264 Level 4.2. The default is the short-side 720 preset at 30 FPS. Cancelling an export discards the partial result.

### Project settings and browser preferences

Mute track/clip dan opsi export disimpan di sebelah manifest dalam `manifest.settings.json`. Sertakan sidecar ini dalam version control agar preview, CLI export, dan production build memakai setting yang sama. Penyimpanan membutuhkan server development atau CLI preview; deployment statis tidak dapat menulis file sumber.

CLI export resolves settings in this order: **explicit flags → saved project settings → framework defaults**. Muted tracks are excluded from exported audio; preview volume and master mute only affect listening.

Theme, timeline zoom, preview volume, and panel layout are stored locally in the browser. See the [technical guide](docs/technical-guide.md) for the settings schema, SDK integration, and persistence behavior.

## CLI

After installing with `npm install -g ritween`:

```sh
# Open the bundled demo
ritween preview --demo --open

# Render a demo frame at 5.2 seconds
ritween frame --demo --time 5.2 -o artifacts/frame.png

# Export the complete demo
ritween export --demo -o artifacts/video.mp4

# Export your own project with machine-readable output
ritween export --project /path/to/project -o video.mp4 --json
```

Use `--demo` for the bundled example, `--project` for another project or manifest, and `--force` to replace an existing output. See the [CLI guide](CLI.md) for browser selection, encoding controls, output formats, and automation.

## Programmatic export

The package exposes TypeScript source for browser applications using a compatible bundler:

```ts
import { exportMp4 } from "ritween";
import { project } from "./src/project/manifest";

const result = await exportMp4(project, {
  width: 1280,
  height: 720,
  fps: 30,
  bitrate: 3_000_000,
  latencyMode: "quality",
  keyFrameInterval: 2,
});
```

`exportVideo` is an alias of `exportMp4`. Automatic bitrate scales with resolution and FPS when `bitrate` is omitted. A bitrate target is not a file-size limit. See the [engine guide](src/engine/README.md) for renderer, frame source, and export architecture.

## Development

To work on Ritween itself, clone the repository and start the development studio:

```sh
git clone https://github.com/nexifle/ritween.git
cd ritween
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173). Scene and manifest edits update the composition while the studio stays mounted.

Run tests and create a production build:

```sh
npm test
npm run build
```

`npm run build` compiles the SDK, studio, CLI renderer, Node CLI, and bundled demo into `dist/`, and generates SDK declarations in `types/`. Published packages contain these build outputs, not `src/`. Vite still compiles user-authored projects at runtime.

After building, use `npm run preview` to open the built studio with the bundled demo. It defaults to port 5173 and selects the next free port if busy. Set a port with `npm run preview -- --port 8080`, or use `--port 0` for an automatically assigned port. From this checkout, `npm run cli -- <arguments>` runs the built CLI without a global install. `npm install -g .` builds and installs the checkout as the `ritween` command.

Additional validation is available for the studio and native browser pipeline:

```sh
npm run test:preview
npm run test:project-settings
npm run test:studio-preferences
npm run test:cli
npm run test:live-preview # Build first; starts its own CLI server and Chrome.
npm run test:preview-exports # Build first; validates backend export and recovery.
npm run test:mp4-input # Build first; requires FFmpeg with libx264/libx265/libaom-av1 and Chrome.
RITWEEN_RANGE_MEDIA=1 npm run test:mp4-input

# Start npm run dev in another terminal; Google Chrome must be installed.
npm run test:browser
```

Browser validation requires actual GPU and codec support. `BASE_URL` and `CHROME_CHANNEL` override the browser validation defaults. Generated media and reports go into the ignored `artifacts/` directory. `test:live-preview` verifies visual scene/helper updates, state preservation, error recovery, superseded updates, and settings HMR; set `CLI_BINARY` to an independently installed Ritween executable to run the same checks against a packaged release.

```text
src/engine/    Timeline, GPU rendering, audio, codecs, and MP4 muxing
src/project/   Bundled composition, scenes, and audio
src/preview/   React studio interface
bin/ + cli/    Node CLI and browser automation
tests/        Unit tests
scripts/       Browser validation and benchmarks
```

See the [preview organization guide](src/preview/README.md) before adding studio features.

## Current scope

Ritween currently supports sequential, gapless scenes with hard cuts. Overlapping transitions, clip dragging, microphone input, and HTML/DOM rasterization are not implemented.

Studio exports run in a backend-owned headless Chrome/Chromium, not in the user's tab. Progress survives page refresh and tab closure while the server runs. Temporary results appear in the **Exports** tab for download or deletion; normal server shutdown removes them, while completed files left after a crash can be recovered on the next preview. Download videos you want to keep before stopping the server. See [Studio export jobs and temporary files](CLI.md#studio-export-jobs-and-temporary-files) for retention and limits.

Export still keeps encoded samples in memory rather than streaming the muxer output to disk; files of 4 GiB or more are rejected. Moving encoding to a headless browser isolates the Studio tab but does not guarantee lower total RAM/GPU use. Browser and platform codec support determine which exports are available.

## Contributing

Contributions are welcome. For substantial changes, open an issue describing the proposed behavior before implementation. Keep changes focused, add behavior tests for engine changes, and run `npm test` and `npm run build` before submitting a pull request. Include screenshots for studio UI changes and relevant browser validation for rendering or codec changes.

## License

Ritween is available under the [MIT License](LICENSE).

Engineered by **[Nexifle Lab](https://nexifle.com)** · [ritween.nexifle.com](https://ritween.nexifle.com)
