import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadVerifiedArchive, ensureManagedPython, managedPythonTarget, runVoiceSetupCommand, UV_VERSION, PYTHON_VERSION } from '../src/managedPython.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('cancelled setup neither downloads nor starts a runtime, and interrupts its owned child',async()=>{
  const cancelled=new AbortController(); cancelled.abort();
  let fetched=false;
  await assert.rejects(downloadVerifiedArchive('https://example.invalid','0'.repeat(64),{signal:cancelled.signal,fetchImpl:async()=>{fetched=true;}}),{name:'AbortError'});
  assert.equal(fetched,false);
  const active=new AbortController();
  const pending=runVoiceSetupCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:active.signal});
  setTimeout(()=>active.abort(),30);
  await assert.rejects(pending,{name:'AbortError'});
});
test('managed Python targets pin independent archive digests for six desktop targets', () => {
  const hashes = new Set();
  for (const platform of ['darwin','linux','win32']) for (const arch of ['x64','arm64']) {
    const target = managedPythonTarget(platform,arch);
    assert.match(target.sha256,/^[0-9a-f]{64}$/); hashes.add(target.sha256);
    assert.equal(target.extension,platform==='win32'?'zip':'tar.gz');
  }
  assert.equal(hashes.size,6);
  assert.throws(()=>managedPythonTarget('linux','ia32'),/requires macOS/);
});
test('runtime download verifies bytes before any extraction and bounds streamed rather than declared length',async()=>{
  const bytes=Buffer.from('reviewed archive');
  assert.deepEqual(await downloadVerifiedArchive('https://example.invalid',sha(bytes),{fetchImpl:async()=>new Response(bytes)}),bytes);
  await assert.rejects(downloadVerifiedArchive('https://example.invalid','0'.repeat(64),{fetchImpl:async()=>new Response(bytes)}),/checksum/);
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(9));},cancel(){cancelled=true;}});
  await assert.rejects(downloadVerifiedArchive('https://example.invalid',sha(bytes),{maxBytes:8,fetchImpl:async()=>new Response(stream,{headers:{'content-length':'1'}})}),/size limit/);
  assert.equal(cancelled,true);
});
test('verified installed uv prepares isolated Python without downloading or needing global Python',async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'next-coder-python-test-'));
  try{
    const root=join(stateDir,'voice','runtime');await mkdir(root,{recursive:true});
    const binary=Buffer.from('verified runtime fixture');await writeFile(join(root,'uv'),binary);
    const target=managedPythonTarget('darwin','arm64');
    await writeFile(join(root,'uv-receipt.json'),JSON.stringify({version:UV_VERSION,target:target.target,archiveSha256:target.sha256,binarySha256:sha(binary)}));
    const calls=[];
    const result=await ensureManagedPython({stateDir,platform:'darwin',arch:'arm64',fetchImpl:async()=>{throw Error('unexpected download');},run:async(command,args,options)=>{
      calls.push({command,args,env:options.env});
      return{stdout:args[1]==='find'?join(root,'python','cpython-managed','bin','python3.12')+'\n':''};
    }});
    assert.equal(calls.length,2);assert.deepEqual(calls[0].args,['python','install',PYTHON_VERSION]);
    assert.equal(calls[0].env.UV_PYTHON_INSTALL_DIR,join(root,'python'));
    assert.equal(calls[0].env.UV_NO_CONFIG,'1');
    assert.equal(result.uvPath,join(root,'uv'));
    await assert.rejects(ensureManagedPython({stateDir,platform:'darwin',arch:'arm64',run:async()=>({stdout:'/usr/bin/python3'})}),/invalid runtime path/);
  }finally{await rm(stateDir,{recursive:true,force:true});}
});
test('a tampered installed runtime is never executed and an invalid replacement is rejected',async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'next-coder-python-tamper-'));
  try{
    const root=join(stateDir,'voice','runtime');await mkdir(root,{recursive:true});
    const target=managedPythonTarget('darwin','arm64');
    await writeFile(join(root,'uv'),Buffer.from('tampered binary'));
    await writeFile(join(root,'uv-receipt.json'),JSON.stringify({version:UV_VERSION,target:target.target,archiveSha256:target.sha256,binarySha256:sha(Buffer.from('original binary'))}));
    let executed=false;
    await assert.rejects(ensureManagedPython({stateDir,platform:'darwin',arch:'arm64',run:async()=>{executed=true;},fetchImpl:async()=>new Response('corrupt archive')}),/checksum/);
    assert.equal(executed,false);
  }finally{await rm(stateDir,{recursive:true,force:true});}
});
