/** Host-native runtime payload for the standalone launcher; never accepts user archives. */
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  readFile,
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
  access,
} from "node:fs/promises";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
export async function materialize(payload) {
  const compressed = await readFile(payload);
  const fingerprint = createHash("sha256")
    .update(compressed)
    .digest("hex")
    .slice(0, 24);
  const cache =
    process.env.RIMOTION_CACHE_DIR ||
    (process.platform === "darwin"
      ? join(homedir(), "Library/Caches/rimotion")
      : join(
          process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
          "rimotion",
        ));
  const root = join(
    cache,
    `${process.platform}-${process.arch}-${fingerprint}`,
  );
  try {
    await access(join(root, ".complete"));
    return root;
  } catch {}
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, ".extract-"));
  try {
    const bytes = gunzipSync(compressed);
    let at = 0;
    while (at < bytes.length) {
      if (at + 4 > bytes.length)
        throw Error("Truncated binary runtime payload.");
      const length = bytes.readUInt32BE(at);
      at += 4;
      if (at + length > bytes.length) throw Error("Truncated runtime header.");
      const header = JSON.parse(bytes.subarray(at, at + length).toString());
      at += length;
      const target = resolve(staging, header.path);
      if (
        isAbsolute(header.path) ||
        !target.startsWith(staging + "/") ||
        !Number.isSafeInteger(header.size) ||
        header.size < 0 ||
        at + header.size > bytes.length
      )
        throw Error("Invalid runtime entry.");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes.subarray(at, at + header.size), {
        mode: header.mode,
      });
      at += header.size;
    }
    await writeFile(join(staging, ".complete"), fingerprint);
    try {
      await rename(staging, root);
    } catch (error) {
      try {
        await access(join(root, ".complete"));
      } catch {
        throw error;
      }
      await rm(staging, { recursive: true, force: true });
    }
    return root;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
