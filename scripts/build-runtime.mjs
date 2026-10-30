import { build, transformWithEsbuild } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile, writeFile, mkdir, readdir, rm, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, dirname } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = resolve(root, "dist");
await rm(outDir, { recursive: true, force: true });
const virtual = [
  "virtual:ritween-project",
  "virtual:ritween-sources",
  "virtual:ritween-live",
];
await build({
  configFile: false,
  root,
  logLevel: "warn",
  plugins: [react(), tailwindcss()],
  build: {
    outDir,
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: {
        index: resolve(root, "src/index.ts"),
        studio: resolve(root, "src/main.tsx"),
        renderer: resolve(root, "src/cli-browser.ts"),
        schema: resolve(root, "src/engine/project-settings-schema.ts"),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: "studio",
    },
    rollupOptions: {
      external: virtual,
    },
  },
});
await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: false,
    copyPublicDir: false,
    ssr: true,
    lib: {
      entry: resolve(root, "cli/main.ts"),
      formats: ["es"],
      fileName: () => "cli.js",
    },
    rollupOptions: {
      external: [
        /^node:/,
        "vite",
        "@vitejs/plugin-react",
        "@tailwindcss/vite",
        "playwright-core",
      ],
      output: { entryFileNames: "cli.js" },
    },
  },
});
const html = (await readFile(resolve(root, "index.html"), "utf8"))
  .replace('src="/src/main.tsx"', 'src="/studio.js"')
  .replace("</head>", '<link rel="stylesheet" href="/studio.css"></head>');
await writeFile(resolve(outDir, "index.html"), html);
// Keep the studio icon available when a project supplies its own public directory.
await cp(resolve(root, "public/favicon.svg"), resolve(outDir, "favicon.svg"));
await cp(resolve(root, "public"), resolve(outDir, "public"), {
  recursive: true,
});

// Keep demo modules separate so the studio can still display each scene's source.
async function buildDemo(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await buildDemo(source);
      continue;
    }
    const target = resolve(
      outDir,
      "demo",
      relative(resolve(root, "src/project"), source).replace(
        /\.(ts|tsx)$/,
        ".js",
      ),
    );
    await mkdir(dirname(target), { recursive: true });
    if (!/\.(ts|tsx|js)$/.test(entry.name)) {
      await cp(source, target);
      continue;
    }
    let code = (
      await transformWithEsbuild(await readFile(source, "utf8"), source, {
        loader: entry.name.endsWith("tsx")
          ? "tsx"
          : entry.name.endsWith("ts")
            ? "ts"
            : "js",
        target: "es2022",
      })
    ).code;
    code = code.replace(
      /(from\s+["'])(\.[^"']+)(["'])/g,
      (_match, prefix, specifier, quote) =>
        `${prefix}${/\.js$/.test(specifier) ? specifier : `${specifier}.js`}${quote}`,
    );
    code = code.replace(
      /source:\s*(["'])([^"']+)\.(ts|tsx)\1/g,
      'source: "$2.js"',
    );
    await writeFile(target, code);
  }
}
await buildDemo(resolve(root, "src/project"));
