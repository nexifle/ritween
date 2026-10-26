import { spawn } from "node:child_process";
function audioPcm(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-f",
      "f32le",
      "-",
    ]);
    const chunks = [];
    let error = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(error)),
    );
  });
}
/** Decode independently, outside benchmark timing. Samples are stereo Float32. */
export async function compareDecodedAudio(reference, candidate) {
  const a = await audioPcm(reference),
    b = await audioPcm(candidate);
  if (!a.length || a.length !== b.length || a.length % 8)
    throw Error("Decoded stereo audio sample counts differ.");
  const samples = a.length / 4;
  let diff2 = 0,
    a2 = 0,
    b2 = 0,
    dot = 0,
    sumA = 0,
    sumB = 0,
    max = 0;
  for (let i = 0; i < samples; i++) {
    const x = a.readFloatLE(i * 4),
      y = b.readFloatLE(i * 4),
      d = x - y;
    diff2 += d * d;
    a2 += x * x;
    b2 += y * y;
    dot += x * y;
    sumA += x;
    sumB += y;
    max = Math.max(max, Math.abs(d));
  }
  let bestLagFrames = 0,
    bestScore = -Infinity;
  for (let lag = -4; lag <= 4; lag++) {
    let xy = 0,
      xx = 0,
      yy = 0;
    for (let frame = 4; frame < samples / 2 - 4; frame += 64) {
      const x = a.readFloatLE(frame * 8),
        y = b.readFloatLE((frame + lag) * 8);
      xy += x * y;
      xx += x * x;
      yy += y * y;
    }
    const score = xy / Math.sqrt(xx * yy);
    if (score > bestScore) {
      bestScore = score;
      bestLagFrames = lag;
    }
  }
  return {
    sampleFrames: samples / 2,
    identical: diff2 === 0,
    referenceRms: Math.sqrt(a2 / samples),
    candidateRms: Math.sqrt(b2 / samples),
    differenceRms: Math.sqrt(diff2 / samples),
    maxAbsoluteDifference: max,
    differenceSnrDb: diff2 ? 10 * Math.log10(a2 / diff2) : null,
    correlation:
      (dot - (sumA * sumB) / samples) /
      Math.sqrt(
        (a2 - (sumA * sumA) / samples) * (b2 - (sumB * sumB) / samples),
      ),
    bestLagFramesWithin4: bestLagFrames,
  };
}
