import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildDeviceThreadOutput } from "../src/deviceThreadOutput.mjs";

async function native(t, code) {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const directory = await mkdtemp(join(tmpdir(), "next-coder-response-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "Arduino.h"), `#pragma once
#include <string>
#include <cstdint>
class String: public std::string {
public: using std::string::string; using std::string::operator=;
 String(const std::string& value):std::string(value){}
 String substring(size_t first,size_t end)const{return substr(first,end-first);}
};
`);
  await writeFile(join(directory, "check.cpp"), code);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", "-I", directory, "-I", resolve("firmware/shared/NextCoderCore/src"), join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
}

test("every word of a gateway page survives narrow-display subpages", async (t) => {
  const text = Array(3).fill("aaaaaaaaa bbbbbbbbbb ccccccccc").join(" ");
  const response = buildDeviceThreadOutput({ thread: { id: "fixture", messages: [{ id: "reply", role: "assistant", text }] } }).response;
  assert.equal(response.pageCount, 1);
  assert.equal(response.truncated, false);
  await native(t, `
#include <cassert>
#include "OperateModel.h"
#include "ResponseLayout.h"
int main() {
 String source[] = {${response.lines.map(JSON.stringify).join(",")}};
 String shown[6];
 auto first=layoutResponsePage(source,3,19,6,0,shown,6);
 assert(first.totalLines==7 && first.pageCount==2 && first.lineCount==6);
 String recovered;
 for(size_t page=0;page<first.pageCount;++page) {
   auto layout=layoutResponsePage(source,3,19,6,page,shown,6);
   for(size_t i=0;i<layout.lineCount;++i) { if(recovered.length()) recovered+=' '; recovered+=shown[i]; }
 }
 assert(recovered==${JSON.stringify(response.lines.join(" "))});
 auto last=layoutResponsePage(source,3,19,6,(size_t)-1,shown,6);
 assert(last.page==1 && last.lineCount==1 && shown[1].empty());
 auto legacy=layoutResponsePage(source,3,31,3,0,shown,6);
 assert(legacy.pageCount==1); // original 31-column boards retain their geometry
 String longWord[]={String(93,'x')};
 String joined;
 for(size_t page=0;page<2;++page) {
   auto layout=layoutResponsePage(longWord,1,8,6,page,shown,6);
   assert(layout.totalLines==12 && layout.pageCount==2);
   for(size_t i=0;i<layout.lineCount;++i) joined+=shown[i];
 }
 assert(joined==longWord[0]); // hard-wrapped tokens are not dropped either
 String empty[]={"", "   "};
 auto blank=layoutResponsePage(empty,2,19,6,99,shown,6);
 assert(blank.page==0 && blank.pageCount==1 && blank.lineCount==0 && shown[0].empty());
}
`);
});

test("actual response read failure branches preserve text, truncation and retry the requested page", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayOperate.cpp", "utf8");
  const start = source.indexOf("bool GatewayClient::fetchResponsePage(");
  const operation = source.slice(start);
  const httpFailure = operation.slice(operation.indexOf("    if (!ok(code)) {"), operation.indexOf("\n    JsonDocument doc;"));
  const badJson = operation.slice(operation.indexOf("    if (deserializeJson(doc, response)) {"), operation.indexOf("\n    JsonObject output"))
    .replace("if (deserializeJson(doc, response))", "if (true)");
  const noObject = operation.slice(operation.indexOf("    if (output.isNull()) {"), operation.indexOf("\n    response_.retryPending = false;"))
    .replace("if (output.isNull())", "if (true)");
  // Execute the exact decoder assignment, with the JSON field boundary supplied by a tiny fixture.
  const truncatedAssignment = operation.match(/response_\.truncated = output\["truncated"\] \| false;/u)?.[0];
  const retryPageSelection = operation.split("\n").find((line) => line.includes('if (response_.state == "error"') && line.includes("retryPage"));
  assert.ok(truncatedAssignment);
  assert.ok(retryPageSelection);
  await native(t, `
#include <cassert>
#include "OperateModel.h"
uint32_t millis(){return 100;}
bool ok(int code){return code>=200 && code<300;}
String remedyFor(int){return "Retry reply";}
struct Subject {
 ThreadResponse response_;
 uint32_t nextDisplayAt_=0;
 void touch(){}
 bool failHttp(int page,int code){${httpFailure}return true;}
 bool failJson(int page){${badJson}return true;}
 bool failObject(int page){${noObject}return true;}
 void chooseRetryPage(int& page){${retryPageSelection}}
 void decodeTruncation(bool value){
   struct Field{bool value;bool operator|(bool)const{return value;}};
   struct Output{bool value;Field operator[](const char*)const{return {value};}} output{value};
   ${truncatedAssignment}
 }
};
int main(){
 for(int branch=0;branch<3;++branch){
   Subject s;s.response_.page=2;s.response_.pageCount=8;s.response_.lineCount=1;
   s.response_.lines[0]="Last readable words";s.response_.followUpCount=1;s.decodeTruncation(true);
   bool success=branch==0?s.failHttp(3,503):branch==1?s.failJson(3):s.failObject(3);
   assert(!success && s.response_.state=="error" && s.response_.retryPending);
   assert(s.response_.page==2 && s.response_.pageCount==8 && s.response_.retryPage==3);
   assert(s.response_.lines[0]=="Last readable words" && s.response_.lineCount==1);
   assert(s.response_.truncated && s.response_.followUpCount==0 && !s.response_.errorDetail.empty());
   int retry=2;s.chooseRetryPage(retry);assert(retry==3);
   s.decodeTruncation(false);assert(!s.response_.truncated);
 }
 Subject blank;blank.failJson(0);assert(blank.response_.lineCount==1 && !blank.response_.lines[0].empty());
}
`);
});

test("actual Hosyond response navigation keeps local subpages and puts Retry before pagination", async (t) => {
  const source = await readFile("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp", "utf8");
  const localLayout = source.slice(source.indexOf("constexpr size_t kReplyMaxLines = 6;"), source.indexOf("constexpr Rect kFollowLeft"));
  const navigation = source.slice(source.indexOf("void stepReplyPage(int direction) {"), source.indexOf("// Paint the pending state immediately;"));
  const actionsStart = source.indexOf("    case Screen::Response: {", source.indexOf("void buildActions()"));
  const actions = source.slice(actionsStart + "    case Screen::Response: {".length, source.indexOf("    case Screen::Approvals:", actionsStart));
  await native(t, `
#include <cassert>
#include <vector>
#include "OperateModel.h"
#include "ResponseLayout.h"
constexpr int kCols2=19;
struct Gateway {ThreadResponse r;const ThreadResponse& response(){return r;}bool responseOpen(){return true;}bool responseInFlight(){return false;}} gateway;
Gateway* gw=&gateway;
bool chromeDirty=false,contentDirty=false;
int calls=0,requested=-1;
void queueResponsePage(int page){++calls;requested=page;}
${localLayout}
${navigation}
enum class Act {Refresh,Retry,ReturnThread,PrevPage,NextPage};
std::vector<Act> actions;
bool haveThread(){return true;}
void addAction(Act action,const char*,bool,bool=true){actions.push_back(action);}
void footer(){${actions}
int main(){
 gateway.r.lineCount=3;gateway.r.pageCount=2;gateway.r.messageId="m";
 for(auto& line:gateway.r.lines) line="aaaaaaaaa bbbbbbbbbb ccccccccc";
 String lines[6];auto first=replyLayout(lines);assert(first.pageCount==2 && first.page==0);
 stepReplyPage(1);assert(replyLocalPage==1 && calls==0);
 stepReplyPage(1);assert(calls==1 && requested==1);
 gateway.r.page=1;gateway.r.lines[0]="last page";gateway.r.lines[1]="";gateway.r.lines[2]="";
 auto next=replyLayout(lines);assert(next.page==0);
 stepReplyPage(-1);assert(calls==2 && requested==0);
 gateway.r.page=0;for(auto& line:gateway.r.lines)line="aaaaaaaaa bbbbbbbbbb ccccccccc";
 auto back=replyLayout(lines);assert(back.page==1);
 stepReplyPage(-1);assert(replyLocalPage==0 && calls==2);
 stepReplyPage(-1);assert(replyLocalPage==0 && calls==2); // no beginning wrap
 footer();assert(actions.size()==3 && actions[0]==Act::PrevPage && actions[2]==Act::ReturnThread);
 actions.clear();gateway.r.state="error";stepReplyPage(1);assert(calls==2 && replyLocalPage==0);
 footer();assert(actions.size()==2 && actions[0]==Act::Retry && actions[1]==Act::ReturnThread);
}
`);
});
