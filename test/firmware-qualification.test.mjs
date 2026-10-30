import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
const board=resolve('firmware/Hosyond-ESP32-S3-2.8-Touchscreen');
test('qualification command parser bounds inputs and compile gates exclude release and non-USB builds',async(t)=>{
 const compiler=process.env.CXX||'c++';
 if(spawnSync(compiler,['--version']).error?.code==='ENOENT')return t.skip('Native compiler unavailable');
 const directory=await mkdtemp(join(tmpdir(),'hosyond-qualification-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'check.cpp');await writeFile(file,`#include <cassert>
#include "qualification.h"
int main(){using namespace qualification;
 assert(parse("NCQUAL STATUS").kind==Kind::Status);
 assert(parse("NCQUAL DROP").kind==Kind::Drop);
 assert(parse("NCQUAL PORTAL").kind==Kind::Portal);
 assert(parse("NCQUAL CLOSE").kind==Kind::Close);
 assert(parse("NCQUAL VERIFY").kind==Kind::Verify);
 assert(parse("NCQUAL REPLY").kind==Kind::Reply);
 assert(parse("NCQUAL STRESS 1").count==1);
 assert(parse("NCQUAL STRESS 500").count==500);
 const char* invalid[]={nullptr,"","STATUS","NCQUAL STATUS extra","NCQUAL STRESS 0","NCQUAL STRESS 501","NCQUAL STRESS -1","NCQUAL STRESS 01","NCQUAL STRESS 1000000000","NCQUAL STRESS 1 extra","NCQUAL STRESS 1;DROP","NCQUAL ERASE","NCQUAL VERIFY arbitrary"};
 for(const auto* line:invalid)assert(parse(line).kind==Kind::Invalid);
 assert(kLineCapacity==80);
}
`);
 const flags=['-std=c++17','-I',join(board,'src'),'-DBENCH_SELFTEST=1','-DHOSYOND_QUALIFICATION=1','-DHOSYOND_QUALIFICATION_ALLOWED=1','-DARDUINO_USB_MODE=1','-DARDUINO_USB_CDC_ON_BOOT=1'];
 const binary=join(directory,'check');const compiled=spawnSync(compiler,[...flags,file,'-o',binary],{encoding:'utf8'});assert.equal(compiled.status,0,compiled.stderr);
 assert.equal(spawnSync(binary).status,0);
 const gate=join(directory,'gate.cpp');await writeFile(gate,'#include "qualification.h"\nint main(){}\n');
 const release=spawnSync(compiler,['-std=c++17','-I',join(board,'src'),'-DHOSYOND_QUALIFICATION=1',gate,'-o',binary],{encoding:'utf8'});
 assert.notEqual(release.status,0);assert.match(release.stderr,/explicitly enabled/);
 const nonUsb=spawnSync(compiler,[...flags.filter(f=>!f.startsWith('-DARDUINO_USB')),gate,'-o',binary],{encoding:'utf8'});assert.notEqual(nonUsb.status,0);assert.match(nonUsb.stderr,/native USB CDC/);
 const normal=spawnSync(compiler,['-std=c++17','-I',join(board,'src'),gate,'-o',binary],{encoding:'utf8'});assert.equal(normal.status,0,normal.stderr);
});
test('qualification build override permits only the explicit bench environment',async()=>{
 const source=await readFile(join(board,'scripts/build_overrides.py'),'utf8');
 const run=(environment,enabled)=>spawnSync('python3',['-c',`import os\nos.environ['NEXT_CODER_QUALIFICATION_BENCH']=${JSON.stringify(enabled)}\nclass Env(dict):\n def Append(self,**kwargs): self.update(kwargs)\nenv=Env(PIOENV=${JSON.stringify(environment)})\nexec(${JSON.stringify(source)}, {'env':env,'Import':lambda _:None})\n`],{encoding:'utf8'});
 assert.equal(run('hosyond-es3c28p-bench','1').status,0);
 const rejected=run('hosyond-es3c28p-controller','1');assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/never release/);
 assert.equal(run('hosyond-es3c28p-controller','0').status,0);
 assert.notEqual(run('hosyond-es3c28p-bench','true').status,0);
});
