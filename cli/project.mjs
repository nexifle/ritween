import { readFileSync, realpathSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
export async function resolveProject(input = ".", demo = false, runtimeRoot) {
  if (demo)
    return {
      manifest: resolve(runtimeRoot, "src/project/manifest.ts"),
      directory: runtimeRoot,
    };
  const location = resolve(input);
  let info;
  try {
    info = await stat(location);
  } catch {
    throw Error(`Project path does not exist: ${location}`);
  }
  if (info.isFile()) {
    if (!/\.(?:tsx?|js|jsx|mjs)$/.test(location))
      throw Error("Manifest must be a TS, TSX, JS, JSX or MJS module.");
    return { manifest: location, directory: dirname(location) };
  }
  for (const relative of [
    "src/project/manifest.ts",
    "src/project/manifest.tsx",
    "src/project/manifest.js",
    "project/manifest.ts",
    "project/manifest.js",
    "manifest.ts",
    "manifest.tsx",
    "manifest.js",
    "manifest.mjs",
  ]) {
    const manifest = resolve(location, relative);
    try {
      if ((await stat(manifest)).isFile())
        return { manifest, directory: location };
    } catch {}
  }
  throw Error(
    `No project manifest found in ${location}. Pass --project path/to/manifest.ts, or --demo for the bundled example.`,
  );
}
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".cts",
]);
function insideRoot(root, file) {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
/** Scene `source` is a path next to the manifest. Reject anything that leaves that directory. */
export function resolveSceneSource(manifest, source) {
  if (typeof source !== "string") return null;
  const label = source.replaceAll("\\", "/").trim();
  if (!label || label.includes("\0") || label.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(label)) return null;
  const parts = label.split("/");
  if (parts.some((part) => part === "" || part === "..")) return null;
  const extension = label.slice(label.lastIndexOf("."));
  if (!SOURCE_EXTENSIONS.has(extension)) return null;
  let root;
  try {
    root = realpathSync(dirname(manifest));
  } catch {
    return null;
  }
  const file = resolve(root, ...parts);
  if (!insideRoot(root, file)) return null;
  try {
    if (!statSync(file).isFile()) return null;
    const real = realpathSync(file);
    return insideRoot(root, real) ? real : null;
  } catch {
    return null;
  }
}
/** Read each literal `source:` path in the manifest. Missing files are null. */
export function sceneSources(manifest) {
  let text = "";
  try {
    text = readFileSync(manifest, "utf8");
  } catch {
    return { sources: {}, files: [] };
  }
  const sources = {};
  const files = new Set();
  for (const match of text.matchAll(/source\s*:\s*(['"`])([^'"`]+)\1/g)) {
    const label = match[2];
    if (Object.hasOwn(sources, label)) continue;
    const file = resolveSceneSource(manifest, label);
    if (!file) {
      sources[label] = null;
      continue;
    }
    try {
      const body = readFileSync(file, "utf8");
      sources[label] = body.includes("\0") ? null : body;
      if (sources[label] != null) files.add(file);
    } catch {
      sources[label] = null;
    }
  }
  return { sources, files: [...files] };
}
export function projectPlugin(manifest) {
  return {
    name: "rimotion-project",
    resolveId(id) {
      if (id === "virtual:rimotion-project") return "\0rimotion-project";
      if (id === "virtual:rimotion-sources") return "\0rimotion-sources";
    },
    load(id) {
      if (id === "\0rimotion-project")
        return `import * as module from ${JSON.stringify(manifest)}; export const project = Object.assign({}, module).project ?? Object.assign({}, module).default; if (!project) throw new Error('Manifest must export project or a default Project.');`;
      if (id === "\0rimotion-sources") {
        const found = sceneSources(manifest);
        this.addWatchFile(manifest);
        for (const file of found.files) this.addWatchFile(file);
        return `export const sources = ${JSON.stringify(found.sources)};`;
      }
    },
  };
}
