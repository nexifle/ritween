import { stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
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
export function projectPlugin(manifest) {
  return {
    name: "rimotion-project",
    resolveId(id) {
      if (id === "virtual:rimotion-project") return "\0rimotion-project";
    },
    load(id) {
      if (id === "\0rimotion-project")
        return `import * as module from ${JSON.stringify(manifest)}; export const project = Object.assign({}, module).project ?? Object.assign({}, module).default; if (!project) throw new Error('Manifest must export project or a default Project.');`;
    },
  };
}
