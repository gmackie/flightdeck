import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
const script=resolve("scripts/workspace-deploy.mjs");
test("deployment dry run prints a complete plan but makes no remote mutations",()=>{
 const args=["--d1-id","12345678-1234-1234-1234-123456789abc",
 "--stream-id","stream-1234","--account-id","0123456789abcdef0123456789abcdef",
 "--host","analytics.example.com","--access-domain","team.cloudflareaccess.com",
 "--access-aud","0123456789abcdef0123456789abcdef","--admin-email","owner@example.com","--dry-run"];
 const result=spawnSync(process.execPath,[script,...args],{encoding:"utf8"});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/no files or remote resources changed/i);
 assert.match(result.stdout,/D1 metadata database/i);
});
test("rejects malformed identifiers even in dry-run mode",()=>{
 const args=["--d1-id","invalid","--stream-id","stream-1234",
 "--account-id","0123456789abcdef0123456789abcdef","--host","analytics.example.com",
 "--access-domain","team.cloudflareaccess.com","--access-aud","0123456789abcdef0123456789abcdef",
 "--admin-email","owner@example.com","--dry-run"];
 const result=spawnSync(process.execPath,[script,...args],{encoding:"utf8"});
 assert.notEqual(result.status,0);
});
