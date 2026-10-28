import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {createHash} from "node:crypto";
const script = resolve("scripts/source-governance.mjs");
test("source credentials rotate without a gap, then old hash is revoked", () => {
 const dir = mkdtempSync(join(tmpdir(),"flightdeck-source-"));
 try {
  mkdirSync(join(dir,".flightdeck"));
  const h = x => createHash("sha256").update(x).digest("hex");
  const old = "a".repeat(40);
  writeFileSync(join(dir,".flightdeck/sources.json"),JSON.stringify({worker:{sha256:h(old),projectId:"example",allowedEvents:[]}}));
  writeFileSync(join(dir,".flightdeck/source-tokens.json"),JSON.stringify({worker:old}));
  const run = (...args) => {
   const r=spawnSync(process.execPath,[script,...args],{cwd:dir,encoding:"utf8"});
   assert.equal(r.status,0,r.stderr); return r.stdout;
  };
  run("rotate:start","worker");
  const first=JSON.parse(readFileSync(join(dir,".flightdeck/sources.json"),"utf8"));
  assert.equal(first.worker.sha256,h(old));
  assert.equal(first.worker.rotatingSha256.length,1);
  run("rotate:finish","worker");
  const final=JSON.parse(readFileSync(join(dir,".flightdeck/sources.json"),"utf8"));
  assert.notEqual(final.worker.sha256,h(old));
  assert.deepEqual(final.worker.rotatingSha256,[]);
  run("disable","worker");
  const disabled=JSON.parse(readFileSync(join(dir,".flightdeck/sources.json"),"utf8"));
  assert.equal(disabled.worker.enabled,false);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
