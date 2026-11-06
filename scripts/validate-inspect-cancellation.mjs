/** Public CLI cancellation during prepareFrame, with rules and atomic output. */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const directory = resolve("artifacts/g4/closure-cancellation");
await mkdir(directory, { recursive: true });
let ready;
const barrier = new Promise((r) => { ready = r; });
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/preparing") { ready(); return; }
  res.end("ok");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const manifest = `${directory}/manifest.mjs`;
await writeFile(manifest, `export const project={name:"Cancellation barrier",resolution:[64,64],aspectRatio:[1,1],duration:1,scenes:[{id:"barrier",name:"Barrier",source:"fixture",start:0,duration:1,transition:{type:"cut"},create:()=>({setup(){},prepareFrame:async()=>{await fetch("http://127.0.0.1:${port}/preparing")},render(){},dispose(){}})}]};`);
await writeFile(`${directory}/rules.json`, JSON.stringify({schemaVersion:1,rules:[{id:"required",kind:"containment",a:{scope:"scene:barrier",space:"layout",id:"a",bounds:"content"},b:{scope:"scene:barrier",space:"layout",id:"b",bounds:"content"},space:"scene:barrier/layout"}]}));
const output = `${directory}/output.json`;
await writeFile(output, "OLD OUTPUT\n");
const child = spawn(process.execPath, ["bin/ritween.mjs", "inspect", "--project",manifest,"--time","0","--rules",`${directory}/rules.json`,"--output",output,"--force"], { stdio:["ignore","pipe","pipe"] });
let stdout="", stderr="";
child.stdout.on("data", d=>stdout+=d); child.stderr.on("data", d=>stderr+=d);
const exited = new Promise(r=>child.on("exit",(code,signal)=>r({code,signal})));
try {
  const event = await Promise.race([barrier.then(()=>"ready"), exited.then(()=>"early-exit")]);
  assert.equal(event,"ready",stderr);
  child.kill("SIGINT");
  const result=await exited;
  assert.equal(result.code,130,stderr);
  assert.match(stderr,/Cancelled/);
  assert.doesNotMatch(stderr,/ritween inspect: \d+ scope/);
  assert.equal(stdout,"");
  assert.equal(await readFile(output,"utf8"),"OLD OUTPUT\n");
  assert.deepEqual((await readdir(directory)).filter(n=>n.includes(".tmp")),[]);
  await writeFile(`${directory}/result.json`,JSON.stringify({event,...result,stdout,stderr,oldOutputPreserved:true,tempFiles:0},null,2));
  console.log("PASS runtime preparation SIGINT with rules and preserved old output");
  // 65 one-MiB warnings exceed the unchanged public 64-MiB output limit.
  // Shared input text bounds fixture memory; no renderer or limit is replaced.
  await writeFile(manifest, `const warning="x".repeat(1024*1024); export const project={name:"Oversized inspection",resolution:[64,64],aspectRatio:[1,1],duration:1,scenes:[{id:"size",name:"Size",source:"fixture",start:0,duration:1,transition:{type:"cut"},create:()=>({setup(){},render(){},dispose(){},inspect(){return {tree:{kind:"box",path:"root",bounds:{x:0,y:0,width:1,height:1},transform:[1,1,0,0],children:[]},commands:[],warnings:Array(65).fill(warning)}}})}]};`);
  const oversized = spawnSync(process.execPath, ["bin/ritween.mjs", "inspect", "--project", manifest, "--time", "0", "--rules", `${directory}/rules.json`, "--output", output, "--force"], { encoding: "utf8" });
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /over the .*64.00 MiB.*limit/);
  assert.equal(oversized.stdout, "");
  assert.equal(await readFile(output, "utf8"), "OLD OUTPUT\n");
  assert.deepEqual((await readdir(directory)).filter(n=>n.includes(".tmp")), []);
  await writeFile(`${directory}/size-result.json`, JSON.stringify({ exit: oversized.status, stderr: oversized.stderr, inputWarningBytes: 65 * 1024 * 1024, oldOutputPreserved: true, tempFiles: 0 }, null, 2));
  console.log("PASS public output limit with rules and preserved old output");
} finally {
  child.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise(r=>server.close(r));
}
