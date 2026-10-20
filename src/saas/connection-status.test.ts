import {describe,it,expect} from 'vitest';
import express from 'express';
import {createServer} from 'node:http';
import {classifyGoogleConnectionFailure,registerInternalConnectionStatus} from './connection-status.js';
import type {PublicOAuthProvider} from '../public/oauth.js';
describe('Private grant-status bridge (mocked Google provider)',()=>{
 it('classifies missing refresh tokens as reauthorization and transient errors as unavailable',()=>{
  expect(classifyGoogleConnectionFailure(new Error('oauth_refresh_token_missing'))).toBe('reauthorization_required');
  expect(classifyGoogleConnectionFailure(new Error('temporary upstream failure'))).toBe('unavailable');
 });
 it('rejects spoofed requests and exposes only grant status, not tokens',async()=>{
  let calls=0;let revoked=false;
  const provider={googleAuthForUser:async()=>{calls++;if(revoked)throw new Error('Google grant unavailable');return{getAccessToken:async()=>({token:'synthetic-private-token'})};}} as unknown as PublicOAuthProvider;
  const app=express();app.use(express.json());registerInternalConnectionStatus(app,provider,'synthetic-internal-secret-32-characters');
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const send=(token:string)=>fetch(origin+'/internal/account/connection',{method:'POST',headers:{'content-type':'application/json','x-classroom-internal-token':token,'x-forwarded-host':'classroom.jarvis404.com'},body:JSON.stringify({subject:'11111111-1111-4111-8111-111111111111'})});
  try{
   expect((await send('spoof')).status).toBe(404);expect(calls).toBe(0);
   expect(await(await send('synthetic-internal-secret-32-characters')).json()).toEqual({status:'authorized'});
   revoked=true;expect(await(await send('synthetic-internal-secret-32-characters')).json()).toEqual({status:'reauthorization_required'});
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
});
