import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureCatalog} from './basin.mjs';
test('Catalog GET can exit successfully while reporting it is not enabled',async()=>{
 const calls=[];
 const shell={wrangler(args){calls.push(args);return {ok:true,stdout:'Basin Catalog is not enabled for bucket',stderr:''};}};
 await ensureCatalog({shell,names:{bucket:'demo'}});
 assert.deepEqual(calls[1],['basin','catalog','enable','demo']);
});
test('API enables a missing Catalog and preserves an active Catalog',async()=>{
 for(const status of ['missing','active']){
  const calls=[];
  const api={enabled:true,account:path=>path,async call(path,options){calls.push({path,options});if(!options&&status==='missing')throw {code:'provider_request_failed',message:'(404)'};return {status:'active'};}};
  await ensureCatalog({api,names:{bucket:'demo'}});
  assert.equal(calls.length,status==='missing'?2:1);
  if(status==='missing')assert.deepEqual(calls[1],{path:'/r2-catalog/demo/enable',options:{method:'POST'}});
 }
});
