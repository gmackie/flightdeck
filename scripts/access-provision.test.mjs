import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
const script=resolve("scripts/access-provision.mjs");
test("Access preflight is dry-run and needs no authenticated Cloudflare account",()=>{
 const r=spawnSync(process.execPath,[script,"--account-id","0123456789abcdef0123456789abcdef",
  "--host","analytics.example.com","--email","admin@example.com","--dry-run"],{encoding:"utf8"});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/no Cloudflare calls made/i);
 assert.match(r.stdout,/flightdeck/);
});
test("Access provision refuses invalid hosts",()=>{
 const r=spawnSync(process.execPath,[script,"--account-id","0123456789abcdef0123456789abcdef",
  "--host","http://evil.example","--email","admin@example.com","--dry-run"],{encoding:"utf8"});
 assert.notEqual(r.status,0);
});
