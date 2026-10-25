import { parseArgs } from "node:util";
export const help = `Rimotion — code-first WebGPU video rendering

Usage:
  rimotion preview [project]                  Serve live web preview
  rimotion preview [project] --time 5.2 -o frame.png
  rimotion frame [project] --time 5.2 -o frame.png
  rimotion frame [project] --frame 156 --fps 30 -o frame.png
  rimotion export [project] -o video.mp4       Export composition to MP4

Project is a directory or manifest module (default: current directory).
Manifests export a named project or default Project; TS, TSX and JS work.

Options:
  --project PATH           Explicit project directory or manifest
  --demo                   Use bundled eight-second example
  --output, -o PATH        PNG for frame; MP4 for export
  --time SECONDS           Frame timestamp (default: 0)
  --frame INDEX            Zero-based frame index, divided by --fps
  --resolution PRESET      360p, 720p, 1080p or WIDTHxHEIGHT
                           Frame defaults to project base; export to 720p
  --fps N                  24, 30 or 60 (default: 30)
  --port N                 Preview port (default: 5173; next free if busy)
  --open                   Open the web preview in your default browser
  --channel NAME           Browser channel (default: chrome; msedge/chromium)
  --browser PATH           Explicit Chrome/Chromium executable path
  --timeout SECONDS        Render/export timeout (default: 120)
  --force                  Replace an existing output
  --json                   Machine-readable result on stdout; progress on stderr
  --help, -h               Show help
  --version, -v            Show version

Requires Chrome/Chromium with WebGPU; MP4 also requires native H.264 encoding.
Ctrl+C stops the server or cancels rendering. Existing files are kept on failure.
`;
export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      project: { type: "string" },
      demo: { type: "boolean" },
      output: { type: "string", short: "o" },
      time: { type: "string" },
      frame: { type: "string" },
      resolution: { type: "string" },
      fps: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean" },
      channel: { type: "string" },
      browser: { type: "string" },
      timeout: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help || values.version) return values;
  let [command, positionalProject, ...extra] = positionals;
  if (!command) return { ...values, help: true };
  if (!["preview", "frame", "export"].includes(command))
    throw Error(`Unknown command: ${command}. Use --help.`);
  if (extra.length || (positionalProject && values.project))
    throw Error("Pass only one project directory or manifest.");
  if (values.demo && (positionalProject || values.project))
    throw Error("--demo cannot be combined with a project path.");
  if (
    command === "preview" &&
    (values.time !== undefined ||
      values.frame !== undefined ||
      values.output !== undefined)
  )
    command = "frame";
  if (
    command === "export" &&
    (values.time !== undefined || values.frame !== undefined)
  )
    throw Error(
      "Use frame for a single timestamp; export renders the whole composition.",
    );
  if (command !== "preview" && (values.open || values.port !== undefined))
    throw Error("--open and --port apply to web preview only.");
  if (values.time !== undefined && values.frame !== undefined)
    throw Error("Pass --time or --frame, not both.");
  const fps = Number(values.fps ?? 30);
  if (![24, 30, 60].includes(fps)) throw Error("--fps must be 24, 30 or 60.");
  const frame = values.frame === undefined ? undefined : Number(values.frame);
  if (frame !== undefined && (!Number.isInteger(frame) || frame < 0))
    throw Error("--frame must be a nonnegative integer.");
  const time = frame === undefined ? Number(values.time ?? 0) : frame / fps;
  if (!Number.isFinite(time) || time < 0)
    throw Error("--time must be finite and nonnegative.");
  const port = Number(values.port ?? 5173);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("--port must be an integer between 0 and 65535.");
  const timeout = Number(values.timeout ?? 120) * 1000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw Error("--timeout must be positive seconds.");
  const resolution =
    values.resolution ?? (command === "export" ? "720p" : undefined);
  let width, height;
  if (resolution) {
    const presets = {
      "360p": "640x360",
      "720p": "1280x720",
      "1080p": "1920x1080",
    };
    const match = /^(\d+)x(\d+)$/.exec(presets[resolution] ?? resolution);
    if (!match)
      throw Error(
        "Invalid --resolution. Use 360p, 720p, 1080p or WIDTHxHEIGHT.",
      );
    [width, height] = match.slice(1).map(Number);
    if (
      ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192)
    )
      throw Error("Frame dimensions must be between 1 and 8192.");
    if (
      command === "export" &&
      !["640x360", "1280x720", "1920x1080"].includes(`${width}x${height}`)
    )
      throw Error("MP4 export supports 360p, 720p or 1080p.");
  }
  const output =
    values.output ?? (command === "frame" ? "frame.png" : "video.mp4");
  if (
    command !== "preview" &&
    !output.toLowerCase().endsWith(command === "frame" ? ".png" : ".mp4")
  )
    throw Error(
      `Output must have a ${command === "frame" ? ".png" : ".mp4"} extension.`,
    );
  return {
    ...values,
    command,
    project: values.project ?? positionalProject ?? ".",
    fps,
    time,
    frame,
    port,
    timeout,
    width,
    height,
    output,
  };
}
