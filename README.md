<div align="center">

# Ritween

**Write scenes. Preview instantly. Export video.**

A code-first video framework powered by WebGPU and native browser codecs.

[Website](https://ritween.nexifle.com) · [Quick start](#quick-start) · [CLI guide](CLI.md) · [Technical guide](docs/technical-guide.md)

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![WebGPU](https://img.shields.io/badge/rendering-WebGPU-005A9C)](https://gpuweb.github.io/gpuweb/)

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

- Node.js **20.19+ within the 20.x line**, or **22.12+**.
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

The CLI prints the local studio URL. Source changes reload automatically.

Visit **[ritween.nexifle.com](https://ritween.nexifle.com)** for the Ritween website.

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

## Use the studio

1. Edit the manifest and scene modules.
2. Press **Space** to play or pause. Use the scrubber to seek and the arrow keys to step through frames.
3. Choose an export size, **24, 30, or 60 FPS**, and automatic or explicit bitrate.
4. Select **Export Video** to encode and download the composition as MP4.

Export sizes preserve the project aspect ratio, using an even frame size with a short side of 360, 720, or 1080 where supported by H.264 Level 4.2. The default is the short-side 720 preset at 30 FPS. Cancelling an export discards the partial result.

### Project settings and browser preferences

Track mutes and export options are saved beside the manifest in `manifest.settings.json`. Commit this sidecar with your project so preview, CLI export, and production builds use the same settings. Saving requires a development or CLI preview server; a static deployment cannot write source files.

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

Open [localhost:5173](http://localhost:5173). Vite reloads changes to scenes and the manifest.

Run tests and create a production build:

```sh
npm test
npm run build
```

Use `npm run preview` to serve the production build. From this checkout, `npm run cli -- <arguments>` runs the CLI without a global install, and `npm install -g .` installs the local checkout as the `ritween` command.

Additional validation is available for the studio and native browser pipeline:

```sh
npm run test:preview
npm run test:project-settings
npm run test:studio-preferences
npm run test:cli

# Start npm run dev in another terminal; Google Chrome must be installed.
npm run test:browser
```

Browser validation requires actual GPU and codec support. `BASE_URL` and `CHROME_CHANNEL` override the browser validation defaults. Generated media and reports go into the ignored `artifacts/` directory.

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

Export keeps encoded samples in memory rather than streaming to disk; files of 4 GiB or more are rejected. Encoding runs asynchronously on the UI thread, so demanding compositions can affect preview responsiveness. Browser and platform codec support determine which exports are available.

## Contributing

Contributions are welcome. For substantial changes, open an issue describing the proposed behavior before implementation. Keep changes focused, add behavior tests for engine changes, and run `npm test` and `npm run build` before submitting a pull request. Include screenshots for studio UI changes and relevant browser validation for rendering or codec changes.

## License

Ritween is available under the [MIT License](LICENSE).

Engineered by **[Nexifle Lab](https://nexifle.com)** · [ritween.nexifle.com](https://ritween.nexifle.com)
