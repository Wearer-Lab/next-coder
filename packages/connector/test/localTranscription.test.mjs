import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createLocalTranscriber, inspectLocalTranscription, MAX_VOICE_BYTES, validateParakeetUrl } from "../src/localTranscription.mjs";
const state = { server: "https://cloud.example/ignored", connectorId: "con", secret: "private" };
const health = () => Response.json({status:"ok", model:"nvidia/parakeet-tdt-0.6b-v2", precision:"int8", modelDir:"private/path"});
const bytes = Buffer.from("bounded recording fixture");
const audio = (body = bytes, extra = {}) => new Response(body, {headers:{"content-type":"audio/wav", "x-media-sha256":createHash("sha256").update(bytes).digest("hex"), ...extra}});
function fixture(overrides = {}) {
 const calls=[];
 const client=createLocalTranscriber({state,fetchImpl:async(url,options={})=>{
  calls.push({url:String(url),options});
  if(String(url).endsWith('/healthz'))return overrides.health?.()??health();
  if(String(url).includes('/v1/connector/media/'))return overrides.media?.(options)??audio();
  return overrides.transcribe?.(options)??Response.json({text:'test transcript',durationSeconds:2,modelDir:'private/path'});
 }});
 return {client,calls};
}
test('voice downloads only fixed authenticated cloud route and posts bounded audio only to loopback',async()=>{
 const {client,calls}=fixture();
 const result=await client.transcribe({mediaId:'m1',jobId:'j1'});
 assert.deepEqual({...result,durationMs:0},{text:'test transcript',language:'en',provider:'parakeet-local',model:'nvidia/parakeet-tdt-0.6b-v2',durationMs:0});
 assert.ok(result.durationMs >= 0 && result.durationMs < 1000,'provider latency must not equal recording duration');
 assert.equal(calls[1].url,'https://cloud.example/v1/connector/media/m1?jobId=j1');
 assert.equal(calls[1].options.headers.authorization,'Connector con.private');
 assert.equal(calls[1].options.redirect,'error');
 assert.equal(calls[2].options.headers,undefined);
 assert.equal(calls[2].options.body.get('file').size,bytes.length);
});
test('voice rejects arbitrary URLs, payload fields and unhealthy impostor runtime',async()=>{
 for(const url of ['https://127.0.0.1/v1/transcribe','http://localhost:8977/v1/transcribe','http://evil.example/v1/transcribe','http://127.0.0.1/v1/transcribe?x=1'])assert.throws(()=>validateParakeetUrl(url));
 const {client,calls}=fixture();
 await assert.rejects(client.transcribe({mediaId:'m1',jobId:'j1',url:'https://evil.example'}),{code:'TRANSCRIPTION_INVALID_AUDIO'});
 assert.equal(calls.length,0);
 assert.equal((await inspectLocalTranscription({fetchImpl:async()=>Response.json({status:'ok',model:'impostor',precision:'int8'})})).ready,false);
});
test('voice enforces digest, streaming byte bound, media authorization and transcript bounds',async()=>{
 for(const overrides of [
  {media:()=>audio(bytes,{'x-media-sha256':'0'.repeat(64)})},
  {media:()=>audio(Buffer.alloc(MAX_VOICE_BYTES+1))},
  {media:()=>audio(bytes,{'content-type':'text/html'})},
 ]) await assert.rejects(fixture(overrides).client.transcribe({mediaId:'m',jobId:'j'}),{code:'TRANSCRIPTION_INVALID_AUDIO'});
 await assert.rejects(fixture({media:()=>new Response(null,{status:403})}).client.transcribe({mediaId:'m',jobId:'j'}),{code:'MEDIA_ACCESS_DENIED',retryable:false});
 await assert.rejects(fixture({transcribe:()=>Response.json({text:'x'.repeat(12001)})}).client.transcribe({mediaId:'m',jobId:'j'}),{code:'TRANSCRIPTION_EMPTY'});
});
test('voice concurrency is one and cancellation releases capacity',async()=>{
 let arrived;const started=new Promise(r=>{arrived=r;});
 let block=true;
 const {client}=fixture({media:async({signal})=>{if(!block)return audio();arrived();return await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 const controller=new AbortController();
 const first=client.transcribe({mediaId:'m',jobId:'j'},{signal:controller.signal});
 await started;
 await assert.rejects(client.transcribe({mediaId:'m2',jobId:'j2'}),{code:'TRANSCRIPTION_UNAVAILABLE',retryable:true});
 controller.abort();await assert.rejects(first,{code:'TRANSCRIPTION_TIMEOUT'});
 block=false;assert.equal((await client.transcribe({mediaId:'m',jobId:'j'})).text,'test transcript');
});
test('cancellation interrupts a stalled media body, not only response headers',async()=>{
 let arrived;const started=new Promise(r=>{arrived=r;});let cancelled=false;
 const {client}=fixture({media:()=>{arrived();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'audio/wav'}});}});
 const controller=new AbortController();const pending=client.transcribe({mediaId:'m',jobId:'j'},{signal:controller.signal});
 await started;await new Promise(r=>setImmediate(r));controller.abort();
 await assert.rejects(pending,{code:'TRANSCRIPTION_TIMEOUT'});assert.equal(cancelled,true);
});
