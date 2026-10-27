import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Run npm's Windows Node shim without cmd.exe interpreting the CLI arguments.
export function nodeCli(
  command,
  { platform = process.platform, env = process.env } = {},
) {
  if (platform !== "win32" || /\.exe$/i.test(command))
    return { command, args: [] };
  if (isAbsolute(command) && /\.(?:mjs|cjs|js)$/i.test(command))
    return { command: process.execPath, args: [command] };
  const path =
    Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ??
    "";
  const candidates = isAbsolute(command)
    ? [command]
    : path
        .split(";")
        .filter(Boolean)
        .map((directory) => join(directory.replace(/^"|"$/g, ""), command));
  for (const candidate of candidates) {
    const shim = /\.cmd$/i.test(candidate) ? candidate : `${candidate}.cmd`;
    let source;
    try {
      source = readFileSync(shim, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    const target = source.match(
      /"%dp0%[\\/]([^"\r\n]+\.(?:mjs|cjs|js))"/i,
    )?.[1];
    if (!target) throw Error(`Unsupported Node CLI shim: ${shim}`);
    const entry = resolve(dirname(shim), target.replaceAll("\\", "/"));
    if (!statSync(entry).isFile())
      throw Error(`Missing Node CLI entry: ${entry}`);
    return { command: process.execPath, args: [entry] };
  }
  throw Error(`Node CLI not found on PATH: ${command}`);
}
