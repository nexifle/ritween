import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
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
