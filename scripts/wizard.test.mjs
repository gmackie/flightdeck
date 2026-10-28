import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,existsSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
const script=resolve("scripts/wizard.mjs");
test("wizard dry-run never writes files or invokes Wrangler",()=>{
 const dir=mkdtempSync(join(tmpdir(),"flightdeck-wizard-"));
 try{
  const res=spawnSync(process.execPath,[script,"--dry-run"],{cwd:dir,encoding:"utf8"});
  assert.equal(res.status,0,res.stderr);
  assert.match(res.stdout,/No network calls or files are written/);
  assert.equal(existsSync(join(dir,".flightdeck")),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("wizard help works without Cloudflare credentials",()=>{
 const res=spawnSync(process.execPath,[script,"--help"],{encoding:"utf8"});
 assert.equal(res.status,0,res.stderr);
 assert.match(res.stdout,/Usage: pnpm wizard/);
});
