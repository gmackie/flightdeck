import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
const script=resolve("scripts/workspace-deploy.mjs");
test("dry-run does not create deployment artifacts or run Wrangler",()=>{
  const temp=mkdtempSync(join(tmpdir(),"flightdeck-install-"));
  try{
    const args=["--d1-id","12345678-1234-1234-1234-123456789abc",
      "--stream-id","stream123456","--account-id","0123456789abcdef0123456789abcdef",
      "--host","flightdeck.example.com","--access-domain","team.cloudflareaccess.com",
      "--access-aud","0123456789abcdef0123456789abcdef","--admin-email","admin@example.com",
      "--dry-run"];
    const result=spawnSync(process.execPath,[script,...args],{cwd:temp,encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/no files or remote resources changed/i);
    assert.equal(existsSync(join(temp,".flightdeck")),false);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
