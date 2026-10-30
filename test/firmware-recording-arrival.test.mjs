import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('actual recording arrival clears all 272 content rows before pump and freezes capture destination',async t=>{
 const cc=process.env.CXX||'c++';if(spawnSync(cc,['--version']).error?.code==='ENOENT')return t.skip('Native compiler unavailable');
 const src=await readFile('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp','utf8');
 const a=src.indexOf('void startRecording() {'),b=src.indexOf('\n}\n',a)+2;assert.ok(a>=0&&b>a);
 const dir=await mkdtemp(join(tmpdir(),'hosyond-recording-arrival-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const code=`
#include <cassert>
#include <string>
#include <algorithm>
using String=std::string;
constexpr int kW=240,kH=320,kContentTop=48,kBg=17;
enum class Screen{Send,Wifi};enum class Modal{None,Confirm};Screen screen;Modal modal;
struct Context{String environmentId,threadId;};struct Gateway{Context ctx;Context context(){return ctx;}}gateway;Gateway*gw=&gateway;
bool busy,journey,threadOK,clipHeld,recordArmed,contentDirty,composeOK,micOK,beginOK,captureOK;
unsigned clipHeldMs,recordPaintedAt,recordOrbAt;
String message,voiceCaptureEnvironment,voiceCaptureThread,voiceCaptureTitle,statusLabel,currentLabel="Listening";
int starts,paints,arrivals,composes,fills,presentations,begins,pixels[kW*kH];
bool uiNetworkBusy(){return busy;}bool voiceInJourney(){return journey;}bool haveThread(){return threadOK;}String threadTitle(){return "Original title";}
struct Voice{bool canStartCapture(){return captureOK;}bool beginCapture(const String&e,const String&t){begins++;assert(e=="original-env"&&t=="original-thread");return beginOK;}}voice;
namespace audio{bool available(){return micOK;}void startRecording(){starts++;assert(recordArmed);gateway.ctx={"later-env","later-thread"};}}
int panelGrey(int v){return v;}
struct Gfx{void fillRect(int x,int y,int w,int h,int color){fills++;assert(x==0&&y==48&&w==240&&h==272);std::fill(pixels+y*w,pixels+(y+h)*w,color);}}gfx;
Gfx&g(){return gfx;}
void applyPresentation(){presentations++;assert(starts==1);}
void clearForArrival(){arrivals++;} // Actual arrival is metadata only, no glass clear.
void paintContent(){paints++;assert(recordArmed&&starts==1&&arrivals==1);for(int y=100;y<120;y++)for(int x=20;x<220;x++)pixels[y*kW+x]=99;}
bool displayComposeScene(int y,int h,int color,void(*paint)(void*),void*arg){
 composes++;assert(y==48&&h==272&&color==kBg&&arrivals==1&&starts==1);
 if(!composeOK)return false;
 std::fill(pixels+y*kW,pixels+(y+h)*kW,color);paint(arg);return true;
}
${src.slice(a,b)}
void reset(){screen=Screen::Send;modal=Modal::None;busy=journey=clipHeld=recordArmed=contentDirty=false;threadOK=micOK=beginOK=captureOK=composeOK=true;starts=paints=arrivals=composes=fills=presentations=begins=0;recordPaintedAt=13;recordOrbAt=14;gateway.ctx={"original-env","original-thread"};std::fill(pixels,pixels+kW*kH,777);}
void noStart(){assert(!starts&&!paints&&!arrivals&&!composes&&!fills&&!presentations&&!recordArmed);for(auto p:pixels)assert(p==777);}
void nextPump(){
 // Pump bypasses normal uiTick arrival; stale destination and footer pixels
 // must already be gone. The stub painter changes only the recording capsule.
 assert(composes==1&&paints==1&&arrivals==1&&presentations==1);
 for(int y=0;y<kH;y++)for(int x=0;x<kW;x++)assert(pixels[y*kW+x]==(y<48?777:(y>=100&&y<120&&x>=20&&x<220?99:kBg)));
 assert(voiceCaptureEnvironment=="original-env"&&voiceCaptureThread=="original-thread"&&voiceCaptureTitle=="Original title");
 assert(gateway.ctx.threadId=="later-thread"&&statusLabel=="Listening"&&!recordPaintedAt&&!recordOrbAt);
}
int main(){
 reset();startRecording();nextPump();assert(fills==0);
 reset();composeOK=false;startRecording();nextPump();assert(fills==1);
 for(int i=0;i<6;i++){reset();switch(i){case 0:busy=true;break;case 1:screen=Screen::Wifi;break;case 2:modal=Modal::Confirm;break;case 3:clipHeld=true;break;case 4:journey=true;break;case 5:captureOK=false;break;}startRecording();noStart();assert(!begins);}
 reset();beginOK=false;startRecording();noStart();assert(begins==1);
 reset();micOK=false;startRecording();noStart();assert(contentDirty&&message=="This build has no microphone");
 reset();threadOK=false;startRecording();noStart();assert(contentDirty&&message=="Select a thread first");
}
`;
 await writeFile(join(dir,'check.cpp'),code);
 const built=spawnSync(cc,['-std=c++17',join(dir,'check.cpp'),'-o',join(dir,'check')],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
 const run=spawnSync(join(dir,'check'),[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
});
