import {
  readProjectSettings,
  settingsPath,
  projectSettingsMiddleware,
} from "./project-settings.ts";
import type { Plugin } from "vite";
import type { ProjectSettings } from "../src/engine/types";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
export interface ResolvedProject {
  manifest: string;
  directory: string;
}

export async function resolveProject(
  input = ".",
  demo = false,
  runtimeRoot: string,
): Promise<ResolvedProject> {
  if (demo)
    return {
      manifest: resolve(runtimeRoot, "dist/demo/manifest.js"),
      directory: resolve(runtimeRoot, "dist"),
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
function insideRoot(root: string, file: string) {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
/** Scene `source` is a path next to the manifest. Reject anything that leaves that directory. */
export function resolveSceneSource(manifest: string, source: unknown) {
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
export function sceneSources(manifest: string) {
  let text = "";
  try {
    text = readFileSync(manifest, "utf8");
  } catch {
    return { sources: {}, files: [] };
  }
  const sources: Record<string, string | null> = {};
  const files = new Set<string>();
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
export function projectPlugin(manifest: string, schema: string): Plugin {
  return {
    name: "ritween-project",
    resolveId(id) {
      if (id === "virtual:ritween-project") return "\0ritween-project";
      if (id === "virtual:ritween-sources") return "\0ritween-sources";
      if (id === "virtual:ritween-live") return "\0ritween-live";
    },
    configureServer(server) {
      const file = settingsPath(manifest);
      let publishedSettings: string | undefined;
      const failed = (error: unknown) => {
        publishedSettings = undefined;
        server.ws.send({
          type: "custom",
          event: "ritween:settings-error",
          data: error instanceof Error ? error.message : String(error),
        });
      };
      const publish = (settings: ProjectSettings) => {
        const serialized = JSON.stringify(settings);
        // A PATCH and its filesystem event describe the same saved revision.
        if (serialized === publishedSettings) return;
        publishedSettings = serialized;
        const module = server.moduleGraph.getModuleById("\0ritween-project");
        if (module) void server.reloadModule(module).catch(failed);
      };
      server.watcher.add(file);
      const changed = (path: string) => {
        if (path !== file) return;
        try {
          publish(readProjectSettings(manifest));
        } catch (error) {
          failed(error);
        }
      };
      server.watcher.on("change", changed);
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);
      server.middlewares.use(projectSettingsMiddleware(manifest, publish));
    },
    handleHotUpdate(context) {
      if (context.file === settingsPath(manifest)) return [];
    },
    load(id) {
      if (id === "\0ritween-live") {
        // This bridge stays outside the production bundle so CLI previews retain HMR.
        return `import * as initialProject from "virtual:ritween-project";
          import * as initialSources from "virtual:ritween-sources";
          let project = initialProject;
          let sources = initialSources;
          let snapshot = { ...project, sources: sources.sources, revision: 0, error: "" };
          const listeners = new Set();
          export const getSnapshot = () => snapshot;
          export const subscribe = (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          };
          const notify = () => { for (const listener of listeners) listener(); };
          if (import.meta.hot) {
            import.meta.hot.accept(["virtual:ritween-project", "virtual:ritween-sources"], (modules) => {
              if (!modules.some(Boolean)) {
                failed("Project update failed. Fix syntax or import errors to resume live updates; the last working preview is still available.");
                return;
              }
              project = modules[0] ?? project;
              sources = modules[1] ?? sources;
              snapshot = { ...project, sources: sources.sources,
                revision: snapshot.revision + (modules[0] ? 1 : 0),
                error: modules[0] ? "" : snapshot.error };
              notify();
            });
            const failed = (message) => {
              snapshot = { ...snapshot, error: message };
              notify();
            };
            import.meta.hot.on("vite:error", (event) => failed(event.err.message));
            import.meta.hot.on("ritween:settings-error", failed);
          }`;
      }
      if (id === "\0ritween-project") {
        // Vite treats watched files as implicit imports during dev transforms.
        // A new project has no sidecar until its first edit.
        if (existsSync(settingsPath(manifest)))
          this.addWatchFile(settingsPath(manifest));
        return `import * as module from ${JSON.stringify(manifest)};
          import { mergeProjectSettings } from ${JSON.stringify(schema)};
          const authored = Object.assign({}, module).project ?? Object.assign({}, module).default;
          if (!authored) throw new Error('Manifest must export project or a default Project.');
          export const authoredSettings = authored.settings;
          export const savedSettings = ${JSON.stringify(readProjectSettings(manifest))};
          export const project = { ...authored, settings: mergeProjectSettings(authoredSettings, savedSettings) };`;
      }
      if (id === "\0ritween-sources") {
        const found = sceneSources(manifest);
        this.addWatchFile(manifest);
        for (const file of found.files) this.addWatchFile(file);
        return `export const sources = ${JSON.stringify(found.sources)};`;
      }
    },
  };
}
