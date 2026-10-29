import assert from "node:assert/strict";
import { normalizePath } from "vite";
import { chromium } from "playwright-core";
import { startServer } from "../cli/server.ts";
import { resolveProject } from "../cli/project.ts";

const runtimeRoot = process.cwd();
const project = await resolveProject(
  process.argv[2] ?? ".",
  !process.argv[2],
  runtimeRoot,
);
const { server, url } = await startServer({ runtimeRoot, project });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--autoplay-policy=user-gesture-required"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.audioContexts = [];
    const Native = window.AudioContext;
    window.AudioContext = new Proxy(Native, {
      construct(Target, args) {
        const ctx = Reflect.construct(Target, args);
        window.audioContexts.push(ctx);
        return ctx;
      },
    });
  });
  await page.goto(url);
  await page.getByText("Runtime connected", { exact: true }).waitFor();
  const beforePlay = await page.evaluate(() =>
    window.audioContexts.map((ctx) => ctx.state),
  );
  assert.ok(
    beforePlay.includes("suspended"),
    "preparation must not require autoplay or start output",
  );
  assert.ok(
    !beforePlay.includes("running"),
    "prepared preview stays idle before Play",
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(
    () =>
      Number(document.querySelector('[aria-label="Playback scrubber"]').value) >
      0.1,
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(
    () => window.audioContexts.every((ctx) => ctx.state !== "running"),
    { timeout: 10000 },
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() =>
    window.audioContexts.some((ctx) => ctx.state === "running"),
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  // Exercise the compiler independently of React using real native DSP/output.
  await page.goto(`${url}/__ritween/render`);
  await page.waitForFunction(() => !!window.ritween);
  await page.evaluate((sourceRoot) => {
    const button = document.createElement("button");
    button.textContent = "Validate audio";
    button.onclick = () => {
      window.audioValidation = (async () => {
        const { LiveMix } = await import(`${sourceRoot}/engine/render/live-mix.ts`);
        const { PreviewAudio } = await import(`${sourceRoot}/engine/render/audio.ts`);
        const { project: original } =
          await import("/@id/virtual:ritween-project");
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const ctx = new AudioContext({
          sampleRate: 48000,
          latencyHint: "interactive",
        });
        await ctx.resume();
        const analyser = new AnalyserNode(ctx, { fftSize: 2048 });
        analyser.connect(ctx.destination);
        const mix = new LiveMix(ctx, analyser);
        let schedules = 0;
        const tone = (trackId, frequency) => ({
          id: trackId,
          name: trackId,
          clips: [
            {
              id: trackId,
              name: trackId,
              start: 0,
              duration: 4,
              create: () => ({
                async schedule(host) {
                  schedules++;
                  await wait(30);
                  const oscillator = new OscillatorNode(host.context, {
                    frequency,
                  });
                  const gain = new GainNode(host.context, { gain: 0.05 });
                  oscillator.connect(gain).connect(host.destination);
                  oscillator.start(0);
                  oscillator.stop(4);
                },
              }),
            },
          ],
        });
        const score = {
          ...original,
          audioTracks: [tone("tone", 440), tone("other", 660)],
        };
        const rms = () => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          return Math.sqrt(
            samples.reduce((sum, x) => sum + x * x, 0) / samples.length,
          );
        };
        const first = mix.prepare(score, []);
        const second = mix.prepare(score, []);
        const samePending = first === second;
        await Promise.all([first, second]);
        mix.start(0);
        await wait(200);
        const audibleRms = rms();
        mix.setMuted(["tone", "other"]);
        await wait(200);
        const mutedRms = rms();
        mix.setMuted([]);
        await wait(100);
        const unmutedRms = rms();
        mix.seek(2);
        const seekTime = mix.heard(0);
        await wait(150);
        const spanningVoiceRms = rms();
        mix.stop();
        await mix.prepare(score, ["tone"]);
        mix.start(0);
        await wait(100);
        mix.stop();
        const cachedSchedules = schedules;
        // Identity must invalidate even if track IDs and mute settings match.
        await mix.prepare({ ...score, audioTracks: [tone("tone", 880)] }, [
          "tone",
        ]);
        const mutedReplacementSchedules = schedules;
        await mix.setMuted([]);
        const replacedSchedules = schedules;
        mix.dispose();
        let disposedRejected = false;
        try {
          await mix.prepare(score, []);
        } catch {
          disposedRejected = true;
        }

        // Authored notes may be declared out of time order. A future voice must
        // still enter the lookahead, and backward seek must reset the cursor.
        const sequenced = new LiveMix(ctx, analyser);
        await sequenced.prepare(
          {
            ...original,
            audioTracks: [
              {
                id: "sequence",
                name: "sequence",
                clips: [
                  {
                    id: "sequence",
                    name: "sequence",
                    start: 0,
                    duration: 2,
                    create: () => ({
                      schedule(host) {
                        for (const [start, end] of [
                          [0.8, 1.4],
                          [0, 0.1],
                        ]) {
                          const osc = new OscillatorNode(host.context, {
                            frequency: 550,
                          });
                          const gain = new GainNode(host.context, {
                            gain: 0.05,
                          });
                          osc.connect(gain).connect(host.destination);
                          osc.start(start);
                          osc.stop(end);
                        }
                      },
                    }),
                  },
                ],
              },
            ],
          },
          [],
        );
        sequenced.start(0);
        await wait(350);
        const gapRms = rms();
        await wait(650);
        const futureVoiceRms = rms();
        sequenced.seek(0);
        await wait(100);
        const backwardSeekRms = rms();
        sequenced.dispose();

        let retained;
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const cancelled = new LiveMix(ctx, analyser);
        const nativeOscillator = globalThis.OscillatorNode;
        const pending = cancelled.prepare(
          {
            ...original,
            audioTracks: [
              {
                id: "slow",
                name: "slow",
                clips: [
                  {
                    id: "slow",
                    name: "slow",
                    start: 0,
                    duration: 1,
                    create: () => ({
                      async schedule(host) {
                        retained = host;
                        await gate;
                      },
                    }),
                  },
                ],
              },
            ],
          },
          [],
        );
        await wait(0);
        cancelled.dispose();
        let cancellationRejected = false;
        try {
          await pending;
        } catch (error) {
          cancellationRejected = error.name === "AbortError";
        }
        release();
        let retainedRejected = false;
        try {
          retained.context.createGain();
        } catch {
          retainedRejected = true;
        }
        const constructorsRestored =
          globalThis.OscillatorNode === nativeOscillator;

        const failed = new LiveMix(ctx, analyser);
        let attempts = 0;
        const flaky = {
          ...original,
          audioTracks: [
            {
              id: "retry",
              name: "retry",
              clips: [
                {
                  id: "retry",
                  name: "retry",
                  start: 0,
                  duration: 1,
                  create: () => ({
                    schedule() {
                      if (++attempts === 1) throw Error("fixture failure");
                    },
                  }),
                },
              ],
            },
          ],
        };
        let failureRejected = false;
        try {
          await failed.prepare(flaky, []);
        } catch {
          failureRejected = true;
        }
        const retrySucceeded = await failed.prepare(flaky, []);
        failed.dispose();

        // A Play racing an in-flight preparation must share its work; pause/seek
        // before completion must not allow a late start at an obsolete offset.
        let racingSchedules = 0;
        const player = new PreviewAudio();
        const racingScore = {
          ...original,
          audioTracks: [
            {
              id: "race",
              name: "race",
              clips: [
                {
                  id: "race",
                  name: "race",
                  start: 0,
                  duration: 3,
                  create: () => ({
                    async schedule(host) {
                      racingSchedules++;
                      await wait(80);
                      const osc = new OscillatorNode(host.context, {
                        frequency: 330,
                      });
                      osc.connect(host.destination);
                      osc.start(0);
                      osc.stop(3);
                    },
                  }),
                },
              ],
            },
          ],
        };
        const warmup = player.prepare(racingScore);
        const playback = player.play(0, racingScore, []);
        player.seek(1);
        await Promise.all([warmup, playback]);
        const pendingSeekTime = player.heardTime();
        player.stop();
        const stoppedTime = player.heardTime();
        player.dispose();
        const paused = new PreviewAudio();
        const preparation = paused.prepare(racingScore);
        const playing = paused.play(0, racingScore, []);
        paused.stop();
        await Promise.all([preparation, playing]);
        const lateStartPrevented =
          paused.heardTime() === null && !paused.isBlocking();
        paused.dispose();
        await ctx.close();
        const silent = new PreviewAudio();
        const contextCount = window.audioContexts.length;
        await silent.prepare({ ...original, audioTracks: [] });
        await silent.play(0, { ...original, audioTracks: [] }, []);
        const silentNoContext =
          window.audioContexts.length === contextCount &&
          silent.heardTime() === null;
        silent.dispose();
        return {
          samePending,
          audibleRms,
          mutedRms,
          unmutedRms,
          seekTime,
          spanningVoiceRms,
          gapRms,
          futureVoiceRms,
          backwardSeekRms,
          silentNoContext,
          cachedSchedules,
          mutedReplacementSchedules,
          replacedSchedules,
          disposedRejected,
          cancellationRejected,
          retainedRejected,
          constructorsRestored,
          failureRejected,
          retrySucceeded,
          attempts,
          racingSchedules,
          pendingSeekTime,
          stoppedTime,
          lateStartPrevented,
        };
      })();
    };
    document.body.append(button);
  }, `/@fs/${normalizePath(runtimeRoot)}/src`);
  await page.getByRole("button", { name: "Validate audio" }).click();
  const report = await page.evaluate(() => window.audioValidation);
  for (const key of [
    "samePending",
    "disposedRejected",
    "cancellationRejected",
    "retainedRejected",
    "constructorsRestored",
    "failureRejected",
    "retrySucceeded",
    "lateStartPrevented",
    "silentNoContext",
  ])
    assert.equal(report[key], true, key);
  assert.equal(report.cachedSchedules, 2);
  assert.equal(
    report.mutedReplacementSchedules,
    2,
    "Clip muted tidak boleh disiapkan sebelum unmute",
  );
  assert.equal(report.replacedSchedules, 3);
  assert.equal(report.attempts, 2);
  assert.equal(
    report.racingSchedules,
    2,
    "one preparation per preview instance, including racing Play",
  );
  assert.ok(report.audibleRms > 0.01);
  assert.ok(report.mutedRms < 0.0001, "gain mute must actually silence output");
  assert.ok(report.unmutedRms > 0.01);
  assert.ok(
    report.spanningVoiceRms > 0.01,
    "seek must include voices that started before the new offset",
  );
  assert.ok(report.gapRms < 0.0001);
  assert.ok(
    report.futureVoiceRms > 0.01,
    "future notes must enter the bounded lookahead in time order",
  );
  assert.ok(
    report.backwardSeekRms > 0.01,
    "backward seek must reset the scheduling cursor",
  );
  assert.ok(
    report.seekTime >= 2,
    "seek must not rewind by the scheduling lead",
  );
  assert.ok(
    report.pendingSeekTime >= 1,
    "seek during preparation must set the eventual offset",
  );
  assert.equal(report.stoppedTime, null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: suspended prewarm, gesture resume, idle suspension, single-flight cache, live mute PCM, seek, project identity, disposal, failure retry and preparation races.",
  );
} finally {
  await browser.close();
  await server.close();
}
