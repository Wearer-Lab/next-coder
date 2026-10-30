// Read-only audit probes: compile extracted firmware branches with small native boundary stubs.
// Does not flash hardware, call production, or modify firmware.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { deviceJobStatus } from '../../../src/deviceAudio.mjs';
import { buildDeviceThreadOutput } from '../../../src/deviceThreadOutput.mjs';
const uiPath='firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp';
const paintPath='firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui_paint.cpp';
// This reproduces the reviewed 0.2.18 baseline. Current-source regressions live in test/firmware-*.test.mjs.
const baseline = '359bfdd';
const ui=execFileSync('git',['show',`${baseline}:${uiPath}`],{encoding:'utf8'}),paint=execFileSync('git',['show',`${baseline}:${paintPath}`],{encoding:'utf8'});
const wrap=paint.slice(paint.indexOf('size_t wrapText('),paint.indexOf('// ---------------------------------------------------------------------------------------------',paint.indexOf('size_t wrapText(')));
const press=ui.slice(ui.indexOf('    case TouchGesture::Press:',ui.indexOf('void uiHandleTouch('))+'    case TouchGesture::Press:'.length,ui.indexOf('    case TouchGesture::Drag:',ui.indexOf('void uiHandleTouch(')));
const text=Array(3).fill('aaaaaaaaa bbbbbbbbbb ccccccccc').join(' ');
const output=buildDeviceThreadOutput({thread:{id:'synthetic',messages:[{id:'synthetic-message',role:'assistant',text,createdAt:'2026-10-23T00:00:00Z'}]}}).response;
assert.equal(output.pageCount,1);assert.equal(output.truncated,false);
const joined=output.lines.join(' ');
const cpp=`
#include <iostream>
#include <string>
#include <algorithm>
using std::min;
struct String:std::string { using std::string::string; String(const std::string& s):std::string(s){} String substring(size_t a,size_t b)const{return String(substr(a,b-a));} };
${wrap}
enum class DragAxis{Undecided}; enum class DragOwner{Drawer,DrawerList,Content}; enum class Modal{None}; enum class Screen{Send};
int dragTravel=0,dragTravelX=0,kContentTop=48,captures=0; DragAxis dragAxis; DragOwner dragOwner; Modal modal=Modal::None; Screen screen=Screen::Send;
bool clipHeld=false,journeyActive=true; float drawerT=0; struct Event{int x=100,y=200;} event;
bool operable(){return true;} int micButtonRect(){return 1;} namespace uip{bool hit(int,int,int){return true;}}
void startRecording(){++captures;}
void extractedPress(){${press}}
int main(){String out[6],full[32];String input=${JSON.stringify(joined)};auto shown=wrapText(input,19,out,6);auto needed=wrapText(input,19,full,32);extractedPress();std::cout<<shown<<" "<<needed<<" "<<captures<<"\\n";}
`;
const dir=await mkdtemp(join(tmpdir(),'next-coder-flow-review-'));
try{
 const file=join(dir,'probe.cpp'),binary=join(dir,'probe');await writeFile(file,cpp);
 const compiled=spawnSync(process.env.CXX||'c++',['-std=c++17',file,'-o',binary],{encoding:'utf8'});assert.equal(compiled.status,0,compiled.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);const [displayedLines,requiredLines,hiddenMicStarts]=run.stdout.trim().split(' ').map(Number);
 assert.equal(hiddenMicStarts,1);assert.equal(displayedLines,6);assert.equal(requiredLines,7);
 const large=buildDeviceThreadOutput({thread:{id:'synthetic',messages:[{id:'long',role:'assistant',text:'word '.repeat(1000),createdAt:'2026-10-23T00:00:00Z'}]}}).response;
 assert.equal(large.pageCount,12);assert.equal(large.truncated,true);
 const approvalProjection=deviceJobStatus({id:'synthetic-approval',stage:'dispatched',dispatchStatus:'approval_required'});assert.equal(approvalProjection.milestone,'review');
 const report={baselineCommit:baseline,historical:true,voicePolicyApproval:{milestone:approvalProjection.milestone,done:approvalProjection.done,scope:'Actual deviceJobStatus projection; fixed Review wording checked separately in GatewayVoice.cpp.'},verifiedAt:new Date().toISOString(),method:'Native extracted firmware code with boundary stubs; real gateway projection with synthetic text. No physical reproduction.',source:{[uiPath]:createHash('sha256').update(ui).digest('hex'),[paintPath]:createHash('sha256').update(paint).digest('hex')},hiddenMicrophone:{journeyActive:true,networkWorkerIdle:true,pressInMicRect:true,startRecordingCalls:hiddenMicStarts,scope:'Actual Press branch; display/gateway/hit-test boundaries stubbed. startRecording reset consequence established separately by source.'},replyTextLoss:{gatewayPageCount:output.pageCount,gatewayTruncated:output.truncated,gatewayLines:output.lines,requiredDeviceLines:requiredLines,displayedDeviceLines:displayedLines,inaccessibleTrailingLines:requiredLines-displayedLines},longReply:{gatewayPageCount:large.pageCount,gatewayTruncated:large.truncated,firmwareStoresTruncatedFlag:false,scope:'Flag omission verified by ThreadResponse and decode source inspection, not native decode execution.'}};
 await writeFile('docs/device-flow/review/evidence.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await rm(dir,{recursive:true,force:true});}
