import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','--','src','tools','.github','*.jsonc'],{encoding:'utf8'}).split('\0').filter(Boolean);
const postgresScheme='postgres'+'(?:ql)?';
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,new RegExp(postgresScheme + "://[^\\s:'\"]+:[^\\s@'\"${}]+@")];
const findings=[];for(const file of files){let text;try{text=readFileSync(file,'utf8');}catch{continue;}text.split(/\r?\n/).forEach((line,index)=>{
  // Exact embedded PGlite socket fixture, not an exemption for arbitrary test credentials.
  if(file==='src/public/postgres-wire.test.ts'&&line.includes(['postgresql://postgres:','postgres@${socket.getServerConn()}/postgres'].join('')))return;
  if(patterns.some(pattern=>pattern.test(line)))findings.push({file,line:index+1,category:'possible_credential'});
});}
console.log(JSON.stringify({scanned:files.length,findings,limits:'Pattern-based tracked source check, not a guarantee of no secrets'}));process.exitCode=findings.length?1:0;
