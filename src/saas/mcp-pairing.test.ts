import {describe,it,expect} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../server.js';

describe('Legacy MCP additive account pairing',()=>{
 it('preserves existing tools and forwards the explicit one-time code',async()=>{
  let received='';
  const server=await createServer({} as never,{publicV1:true,linkWebsiteAccount:async code=>{received=code;return true;}});
  const client=new Client({name:'synthetic-pairing-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  try{
   const tools=await client.listTools();
   expect(tools.tools.some(t=>t.name==='list_courses')).toBe(true);
   expect(tools.tools.some(t=>t.name==='my_submissions')).toBe(true);
   const link=tools.tools.find(t=>t.name==='link_website_account');
   expect(link?.annotations?.readOnlyHint).toBe(false);
   expect(link?._meta).toMatchObject({securitySchemes:[{type:'oauth2',scopes:['mcp:tools']}]});
   const result=await client.callTool({name:'link_website_account',arguments:{code:'synthetic-pairing-code-12345'}});
   expect(received).toBe('synthetic-pairing-code-12345');
   expect(result.content).toEqual([{type:'text',text:JSON.stringify({linked:true},null,2)}]);
   expect(tools.tools.some(t=>t.name==='read_drive_attachment')).toBe(false);
  }finally{await client.close();await server.close();}
 });
});
