import assert from "node:assert/strict";
import test from "node:test";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { startServer } from "../cli/server";
import { resolveProject } from "../cli/project";

test("media loading and activation are initialized before studio and renderer modules", async () => {
  const runtimeRoot = resolve(".");
  const project = await resolveProject(".", true, runtimeRoot);
  const { server, url } = await startServer({
    runtimeRoot,
    project,
    watch: false,
    mediaLoading: "range",
    mediaActivation: "active-only",
  });
  try {
    for (const path of ["/", "/__ritween/render"]) {
      const html = await (await fetch(url + path)).text();
      assert.match(html, /globalThis\.__ritweenRangeVideo = true/);
      assert.match(
        html,
        /globalThis\.__ritweenMediaActivation = "active-only"/,
      );
      assert.ok(
        html.indexOf("__ritweenRangeVideo") < html.indexOf('type="module"'),
      );
    }
  } finally {
    await server.close();
  }
});

test("studio serves its favicon with or without project public assets and permits project overrides", async () => {
  const runtimeRoot = resolve(".");
  const directory = await mkdtemp(join(tmpdir(), "ritween-favicon-"));
  const manifest = join(directory, "manifest.js");
  const publicDirectory = join(directory, "public");
  const bundledIcon = await readFile(
    join(runtimeRoot, "public/favicon.svg"),
    "utf8",
  );
  const customIcon =
    '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>';
  try {
    await writeFile(manifest, "export default {};");
    for (const scenario of [
      "no public directory",
      "public assets",
      "custom favicon",
    ]) {
      if (scenario !== "no public directory") {
        await mkdir(publicDirectory, { recursive: true });
        await writeFile(join(publicDirectory, "asset.txt"), "Project asset");
      }
      if (scenario === "custom favicon")
        await writeFile(join(publicDirectory, "favicon.svg"), customIcon);
      const { server, url } = await startServer({
        runtimeRoot,
        project: { manifest, directory },
        watch: false,
      });
      try {
        const html = await (await fetch(url)).text();
        assert.match(html, /href="\/favicon\.svg"/);
        const response = await fetch(url + "/favicon.svg");
        assert.equal(response.status, 200, scenario);
        assert.match(
          response.headers.get("content-type") ?? "",
          /^image\/svg\+xml\b/,
          scenario,
        );
        assert.equal(
          await response.text(),
          scenario === "custom favicon" ? customIcon : bundledIcon,
          scenario,
        );
        const head = await fetch(url + "/favicon.svg?v=1", { method: "HEAD" });
        assert.equal(head.status, 200, scenario);
        assert.match(
          head.headers.get("content-type") ?? "",
          /^image\/svg\+xml\b/,
          scenario,
        );
        assert.equal(await head.text(), "");
        if (scenario !== "no public directory")
          assert.equal(
            await (await fetch(url + "/asset.txt")).text(),
            "Project asset",
          );
      } finally {
        await server.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built studio loads an unbundled project HMR boundary", async () => {
  const runtimeRoot = resolve(".");
  const project = await resolveProject(".", true, runtimeRoot);
  const { server, url } = await startServer({ runtimeRoot, project });
  try {
    const studio = await (await fetch(url + "/studio.js")).text();
    assert.match(studio, /ritween-live/);
    const response = await fetch(url + "/@id/__x00__ritween-live");
    assert.equal(response.status, 200);
    const bridge = await response.text();
    assert.match(bridge, /import\.meta\.hot\.accept\(/);
    assert.match(bridge, /ritween-project/);
    assert.match(bridge, /ritween-sources/);
    assert.match(bridge, /last working preview/);
    assert.ok(
      !server.config.plugins.some(
        (plugin) => plugin.name === "ritween-built-runtime-reload",
      ),
    );
  } finally {
    await server.close();
  }
});

test("one-shot CLI servers disable HMR and watching while preview keeps both", async () => {
  const runtimeRoot = resolve(".");
  const project = await resolveProject(".", true, runtimeRoot);
  for (const watch of [false, true]) {
    const { server, url } = await startServer({ runtimeRoot, project, watch });
    try {
      assert.equal(server.config.server.hmr, watch);
      assert.equal(server.config.server.watch === null, !watch);
      for (const path of ["/", "/__ritween/render"]) {
        const html = await (await fetch(url + path)).text();
        assert.match(html, /globalThis\.__ritweenRangeVideo = false/);
        assert.match(html, /globalThis\.__ritweenMediaActivation = "eager"/);
        assert.ok(
          html.indexOf("__ritweenRangeVideo") < html.indexOf('type="module"'),
        );
      }
    } finally {
      await server.close();
    }
  }
});
