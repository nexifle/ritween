# Guide: preview, frame, and export

Run `ritween`. Install puts that command on `PATH` (npm, or a curl install into a directory such as `~/.local/bin`). Chrome with WebGPU is required. `--json` prints one success object on stdout. Progress and errors go to stderr.

`preview` with `--time`, `--frame`, or `-o` becomes a frame render and exits. It does not leave the server up.

## Web preview

```sh
ritween preview --open --json
```

Stdout:

```json
{"command":"preview","url":"http://127.0.0.1:5173/","manifest":"/absolute/path/src/project/manifest.ts"}
```

The process stays up until Ctrl+C, which exits `0`. Port `5173` is the default. If it is taken, the URL in the object is the actual port. `--port 0` asks for any free port. The server binds to `127.0.0.1`. Saving a scene or the manifest reloads the page.

`--demo` forces the bundled example. A project path and `--demo` together are an error. One of `--project` or a positional path, not both.

## One PNG

```sh
ritween frame --time 5.2 -o /tmp/frame.png --json
```

Stdout on success:

```json
{
  "command": "frame",
  "output": "/tmp/frame.png",
  "project": "Source to motion",
  "time": 5.2,
  "width": 1280,
  "height": 720,
  "bytes": 182341,
  "elapsedSeconds": 3.4
}
```

`bytes` and `elapsedSeconds` vary. `width` and `height` follow the project base resolution unless `--resolution` is set. `frame` accepts `360p`, `720p`, `1080p`, or `WIDTHxHEIGHT` with each side from 1 to 8192.

Frame index `156` at 30 FPS is time `5.2`:

```sh
ritween frame --frame 156 --fps 30 -o /tmp/frame.png --json --force
```

`--time` and `--frame` together are rejected. The default time is `0`. An existing output path fails until you pass `--force`. A failed run does not replace that file.

Repeat the same `--time` and compare the two PNGs when you need proof the scene is seekable.

## MP4

Set `resolution` to the frame the request names, and pass that same size to `--resolution`.

`360p`, `720p`, and `1080p` are only 640×360, 1280×720, and 1920×1080. They match a 16:9 project. On any other aspect they fail. Every other aspect uses an even `WIDTHxHEIGHT` with the same aspect as `resolution`.

Full HD is the short-side 1080 step. 16:9 full HD is `1080p` (1920×1080). 9:16 full HD is `1080x1920`, with `resolution: [1080, 1920]` and `aspectRatio: [9, 16]`. 1:1 full HD is `1080x1080`. 4:5 full HD is `1080x1350`. HD is the short-side 720 step, so 9:16 HD is `720x1280`, not full HD.

The steps are short side 360, 720, and 1080 when the frame fits H.264 Level 4.2: even dimensions, at most 8704 macroblocks, neither side above 4208. A 21:9 full HD frame does not fit, so that project has no 1080-class size.

Omitting `--resolution` exports the short-side 720 step. That is 1280×720 on 16:9 and 720×1280 on 9:16. It is not full HD. Do not omit the flag when the request names a frame.

The bundled demo is 16:9, so its full-HD export is `1080p` and its default export is `720p`:

```sh
ritween export -o /tmp/video.mp4 --resolution 720p --fps 30 --json
```

Stderr grows in steps of 10 percent:

```json
{"event":"progress","done":24,"total":240,"percent":10}
```

Stdout after a good 8 second demo export:

```json
{
  "command": "export",
  "output": "/tmp/video.mp4",
  "project": "Source to motion",
  "frames": 240,
  "duration": 8,
  "bytes": 7950000,
  "width": 1280,
  "height": 720,
  "fps": 30,
  "elapsedSeconds": 4.1
}
```

`frames` must equal `ceil(duration * fps)`. The 8 second demo at 24, 30, and 60 FPS is 192, 240, and 480 frames. `export` rejects `--time` and `--frame`. Audio tracks in the manifest are mixed with Web Audio and muxed as AAC. A project with no audio tracks stays silent. Every video sample is a keyframe. An output of 4 GiB or more is rejected.

Ctrl+C during frame or export exits `130` and leaves an existing output in place. Other failures exit `1` and look like:

```json
{"event":"error","message":"Output exists: /tmp/video.mp4. Pass --force to replace it."}
```

`--timeout` bounds headless startup and the render. The default is 120 seconds. `--channel chrome` is the default. `--channel msedge`, `--channel chromium`, or `--browser /absolute/path/to/chrome` select another binary.

Open the MP4 and seek it. A successful TypeScript build is not a successful export.
