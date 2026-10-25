import {
  readdir,
  readFile,
  stat,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const staging = join(root, ".binary-build");
const output = resolve(
  process.env.BINARY_OUT ??
    join(
      root,
      "release",
      `rimotion-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
    ),
);
await mkdir(staging, { recursive: true });
await mkdir(resolve(output, ".."), { recursive: true });
const entries = [];
async function collect(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        entry.isSymbolicLink() ||
        entry.name === ".vite" ||
        entry.name === ".cache" ||
        entry.name === ".bin"
      )
        continue;
      await collect(join(path, entry.name));
    }
  } else if (info.isFile()) {
    const data = await readFile(path);
    const header = Buffer.from(
      JSON.stringify({
        path: relative(root, path).split("\\").join("/"),
        size: data.length,
        mode: info.mode & 0o777,
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    entries.push(length, header, data);
  }
}
try {
  for (const path of [
    "cli",
    "bin",
    "src",
    "index.html",
    "package.json",
    "node_modules",
  ])
    await collect(join(root, path));
  const payload = gzipSync(Buffer.concat(entries), { level: 9 });
  await writeFile(join(staging, "runtime.gz"), payload);
  await writeFile(
    join(staging, "launcher.ts"),
    `import payload from './runtime.gz' with {type:'file'};
import {materialize} from '../cli/archive.mjs';
import {spawn} from 'node:child_process';
try {
  const root=await materialize(payload);
  // Re-enter the embedded Bun runtime in normal filesystem module mode.
  // This avoids standalone-mode resolution restrictions for Vite native dependencies.
  const child=spawn(process.execPath,[root+'/bin/rimotion.mjs',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,BUN_BE_BUN:'1'}});
  const int=()=>child.kill('SIGINT'); const term=()=>child.kill('SIGTERM');
  process.on('SIGINT',int); process.on('SIGTERM',term);
  await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:143);resolve();});});
  process.off('SIGINT',int);process.off('SIGTERM',term);
} catch(error) { console.error('Rimotion: '+error.message); process.exitCode=1; }
`,
  );
  const build = spawnSync(
    "bun",
    ["build", "--compile", join(staging, "launcher.ts"), "--outfile", output],
    { stdio: "inherit" },
  );
  if (build.error)
    throw Error(
      `Bun is required to compile the executable: ${build.error.message}`,
    );
  if (build.status !== 0) throw Error(`Binary build failed (${build.status}).`);
  console.log(
    `Built ${output}\nHost target: ${process.platform}/${process.arch}; embedded runtime ${(payload.length / 2 ** 20).toFixed(1)} MiB. Chrome is external; no Node.js/Bun/npm installation is needed to run this executable.`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
