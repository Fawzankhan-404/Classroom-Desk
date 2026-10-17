import type { PublicOAuthProvider } from "../public/oauth.js";
import type express from "express";
import { internalTokenMatches } from "./internal-link.js";
export type ConnectionStatus = "not_linked"|"authorized"|"reauthorization_required"|"unavailable";
export function registerInternalConnectionStatus(app:express.Express,provider:PublicOAuthProvider,secret:string):void {
  app.post('/internal/account/connection',async(req,res)=>{
    if(!internalTokenMatches(req.get('x-classroom-internal-token')??'',secret))return res.status(404).end();
    const subject=req.body?.subject;
    if(typeof subject!=='string'||!/^[0-9a-f-]{36}$/i.test(subject))return res.status(400).end();
    try{
      const auth=await provider.googleAuthForUser(subject);
      const token=await auth.getAccessToken();
      return res.json({status:token.token?'authorized':'reauthorization_required'});
    }catch(error){
      const message=error instanceof Error?error.message:'';
      const status=message==='Google grant unavailable'||message.includes('invalid_grant')?'reauthorization_required':'unavailable';
      return res.json({status});
    }
  });
}
