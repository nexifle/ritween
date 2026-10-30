import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startServer } from "../cli/server.ts";

const directory = await mkdtemp(join(tmpdir(), "ritween-studio-preferences-"));
const manifest = join(directory, "manifest.js");
let server;
let browser;
try {
  const source = `export const project = { name: "Studio preferences", duration: 1, resolution: [64,64], aspectRatio: [1,1], scenes: [{id:"scene",name:"Scene",source:"scene.js",start:0,duration:1,transition:{type:"cut"},create:()=>({setup(){},render(){},dispose(){}})}] };`;
  await writeFile(manifest, source);
  await writeFile(join(directory, "scene.js"), "// Scene source fixture\n");
  const running = await startServer({
    runtimeRoot: process.cwd(),
    project: { manifest, directory },
  });
  server = running.server;
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(running.url);
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Switch to light mode", exact: true })
    .click();
  await page
    .getByRole("slider", { name: "Preview volume", exact: true })
    .fill("-33");
  await page.getByRole("button", { name: "Mute mix", exact: true }).click();
  await page
    .getByRole("slider", { name: "Timeline zoom", exact: true })
    .fill("610");
  const resize = async (separator, key) => {
    await separator.focus();
    await page.keyboard.press(key);
  };
  await resize(page.locator('#ritween-rows > [role="separator"]'), "ArrowUp");
  await resize(
    page.locator('#ritween-columns > [role="separator"]'),
    "ArrowLeft",
  );
  await resize(
    page.locator('#ritween-inspector > [role="separator"]'),
    "ArrowUp",
  );
  await resize(
    page.getByRole("separator", { name: "Resize layer names", exact: true }),
    "ArrowRight",
  );
  const dimensions = () =>
    page.evaluate(() => {
      const rect = (selector) =>
        document.querySelector(selector).getBoundingClientRect();
      return {
        viewer: rect("#ritween-columns > #viewer").width,
        stage: rect("#ritween-rows > #stage").height,
        export: rect("#ritween-inspector > #export").height,
        names: rect("#track-names").width,
      };
    });
  const before = await dimensions();
  const layouts = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith("react-resizable-panels:"))
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  );
  assert.equal(Object.keys(layouts).length, 4);
  await page.reload();
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  const restored = await dimensions();
  for (const key of Object.keys(before))
    assert.ok(
      Math.abs(restored[key] - before[key]) < 2,
      `${key} user size survives reload with both inspector panels open`,
    );
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page
    .getByRole("button", { name: "Minimize Export video", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Minimize Scene source", exact: true })
    .click();
  await page.reload();
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    ),
    false,
  );
  assert.equal(
    await page
      .getByRole("slider", { name: "Preview volume", exact: true })
      .inputValue(),
    "-33",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Unmute mix", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("slider", { name: "Timeline zoom", exact: true })
      .inputValue(),
    "610",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Code", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Expand Export video", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Expand Scene source", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await page
    .getByRole("button", { name: "Expand Export video", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand Scene source", exact: true })
    .click();
  const after = await dimensions();
  for (const key of Object.keys(before))
    assert.ok(
      Math.abs(after[key] - before[key]) < 2,
      `${key} layout is restored`,
    );
  // Responsive changes must not replace the user's desktop sizes.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#ritween-stack").waitFor();
  await resize(
    page.locator('#ritween-stack > [role="separator"]').first(),
    "ArrowUp",
  );
  const stack = await page.evaluate(() =>
    localStorage.getItem("react-resizable-panels:ritween-stack"),
  );
  assert.ok(stack);
  await page.reload();
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("react-resizable-panels:ritween-stack"),
    ),
    stack,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#ritween-rows").waitFor();
  const desktop = await dimensions();
  for (const key of ["viewer", "stage", "export"])
    assert.ok(
      Math.abs(desktop[key] - before[key]) < 2,
      `${key} desktop layout survives mobile`,
    );
  assert.equal(
    await page.getByRole("button", { name: "Play", exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await page
      .getByRole("slider", { name: "Playback scrubber", exact: true })
      .inputValue(),
    "0",
  );
  // Corrupt persisted data recovers without blocking the app.
  await page.evaluate(() => {
    localStorage.setItem("ritween-studio-preferences", "{broken");
    for (const key of Object.keys(localStorage))
      if (key.startsWith("react-resizable-panels:"))
        localStorage.setItem(key, "null");
  });
  await page.reload();
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("slider", { name: "Preview volume", exact: true })
      .inputValue(),
    "-18",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Picture", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  // A browser denying localStorage access still permits all studio controls.
  const blocked = await browser.newPage();
  blocked.on("pageerror", (error) => errors.push(error.message));
  await blocked.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await blocked.goto(running.url);
  await blocked.getByText("Runtime connected", { exact: true }).waitFor();
  await blocked
    .getByRole("button", { name: "Switch to light mode", exact: true })
    .click();
  await blocked
    .getByRole("slider", { name: "Preview volume", exact: true })
    .fill("-30");
  await blocked.close();
  assert.deepEqual(errors, []);
  assert.equal(await readFile(manifest, "utf8"), source);
  assert.deepEqual((await readdir(directory)).sort(), [
    "manifest.js",
    "scene.js",
  ]);
  console.log(
    "PASS: theme, volume/master mute, timeline zoom, panel state, all divider sizes, desktop/mobile layouts, malformed and blocked storage, idle reload and unchanged project source.",
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
