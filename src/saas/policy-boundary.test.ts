import express from 'express';
import {it,expect} from 'vitest';
import {registerInternalLink} from './internal-link.js';
import type {SaaSStore} from './store.js';

it('restricts access policy to its own credential and leaves the retired link endpoint unavailable',async()=>{
  const app=express();app.use(express.json());
  const store={entitlementForMcpUser:async()=>({allowed:false,reason:'none'})} as unknown as SaaSStore;
  const delegation='d'.repeat(43),policy='p'.repeat(43),subject='12345678-1234-1234-1234-123456789012';
  registerInternalLink(app,store,delegation,'',policy);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const send=(path:string,headers:Record<string,string>)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({subject,code:'fixture'})});
  try{
    expect((await send('/internal/account/access',{'x-forwarded-host':'classroom.jarvis404.com'})).status).toBe(404);
    expect((await send('/internal/account/access',{'x-classroom-internal-token':delegation})).status).toBe(404);
    const access=await send('/internal/account/access',{'x-classroom-access-policy-token':policy});expect(access.status).toBe(200);expect(await access.json()).toMatchObject({allowed:false,reason:'none'});
    expect((await send('/internal/account/link',{'x-classroom-access-policy-token':policy})).status).toBe(404);
    expect((await send('/internal/account/link',{'x-classroom-internal-token':delegation})).status).toBe(404);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
