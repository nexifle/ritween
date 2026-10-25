# Guide: preview, frame, and export

Run `rimotion`. Install puts that command on `PATH` (npm, or a curl install into a directory such as `~/.local/bin`). Chrome with WebGPU is required. `--json` prints one success object on stdout. Progress and errors go to stderr.

`preview` with `--time`, `--frame`, or `-o` becomes a frame render and exits. It does not leave the server up.

## Web preview

```sh
rimotion preview --open --json
```

Stdout:

```json
{"command":"preview","url":"http://127.0.0.1:5173/","manifest":"/absolute/path/src/project/manifest.ts"}
```

The process stays up until Ctrl+C, which exits `0`. Port `5173` is the default. If it is taken, the URL in the object is the actual port. `--port 0` asks for any free port. The server binds to `127.0.0.1`. Saving a scene or the manifest reloads the page.

`--demo` forces the bundled example. A project path and `--demo` together are an error. One of `--project` or a positional path, not both.

## One PNG

```sh
rimotion frame --time 5.2 -o /tmp/frame.png --json
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

`bytes` and `elapsedSeconds` vary. `width` and `height` follow the project base resolution unless `--resolution` is set. Frame accepts `360p`, `720p`, `1080p`, or `WIDTHxHEIGHT` with each side from 1 to 8192. Export accepts only `360p` (640×360), `720p` (1280×720), and `1080p` (1920×1080), and defaults to `720p`.

Frame index `156` at 30 FPS is time `5.2`:

```sh
rimotion frame --frame 156 --fps 30 -o /tmp/frame.png --json --force
```

`--time` and `--frame` together are rejected. The default time is `0`. An existing output path fails until you pass `--force`. A failed run does not replace that file.

Repeat the same `--time` and compare the two PNGs when you need proof the scene is seekable.

## MP4

```sh
rimotion export -o /tmp/video.mp4 --resolution 720p --fps 30 --json
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

`frames` must equal `ceil(duration * fps)`. The 8 second demo at 24, 30, and 60 FPS is 192, 240, and 480 frames. `export` rejects `--time` and `--frame`. There is no audio. Every sample is a keyframe. An output of 4 GiB or more is rejected.

Ctrl+C during frame or export exits `130` and leaves an existing output in place. Other failures exit `1` and look like:

```json
{"event":"error","message":"Output exists: /tmp/video.mp4. Pass --force to replace it."}
```

`--timeout` bounds headless startup and the render. The default is 120 seconds. `--channel chrome` is the default. `--channel msedge`, `--channel chromium`, or `--browser /absolute/path/to/chrome` select another binary.

Open the MP4 and seek it. A successful TypeScript build is not a successful export.
