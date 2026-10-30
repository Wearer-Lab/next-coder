import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual preview guards reject old gateways, wrong destinations and mismatched final bindings", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayBrowse.cpp", "utf8");
  const projectsStart = source.indexOf('  if (previewActive_ && (String(doc["destinationSelection"]');
  const projects = source.slice(projectsStart, source.indexOf("  projectCount_ = 0;", projectsStart));
  const threadsStart = source.indexOf('  if (String(doc["destinationSelection"]');
  const threads = source.slice(threadsStart, source.indexOf("  previewThreadCount_ = 0;", threadsStart));
  const commitStart = source.indexOf("  if (deserializeJson(result, response)");
  const commit = source.slice(commitStart, source.indexOf("  boundEnvironmentId_ = previewEnvironmentId_;", commitStart));
  const createStart = source.indexOf("  const String targetEnvironment = previewActive_");
  const create = source.slice(createStart, source.indexOf("  gateway_request::settleDurableDeviceRequest", createStart));
  const directory = await mkdtemp(join(tmpdir(), "next-coder-preview-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "check.cpp"), `
#include <cassert>
#include <string>
#include <map>
using String=std::string;
struct JsonArray {};
struct Node {
 std::map<String,Node> fields;String value;bool array=false;
 Node& operator[](const char* key){return fields[key];}
 const char* operator|(const char*)const{return value.c_str();}
 template<class T>bool is()const{return array;}
};
bool deserializeJson(Node&,const String&){return false;}
struct Subject {
 bool previewActive_=true,previewContractReady_=true;
 String previewEnvironmentId_="envB",previewProjectId_="folderB",projectsDetail_,previewDetail_;
 String boundEnvironmentId_="envB",boundProjectId_="folderB",createDetail_;
 struct BrowseThread{String id;} created_;
 unsigned projectCount_=3,previewThreadCount_=2;
 void touch(){}
 bool projects(Node& doc){String env=doc["environmentId"]|"";${projects}return true;}
 bool threads(Node& doc){${threads}return true;}
 bool commit(Node& result){String response;struct {String id="threadB";} selected;auto* row=&selected;${commit}return true;}
 bool created(Node& doc){created_.id="threadB";${create}return true;}
};
Node fixture(){Node doc;doc["destinationSelection"].value="atomic-v1";doc["environmentId"].value="envB";doc["projectId"].value="folderB";doc["projects"].array=true;doc["threads"].array=true;return doc;}
int main(){
 Subject s;auto valid=fixture();assert(s.projects(valid)&&s.threads(valid));
 auto old=valid;old["destinationSelection"].value="";
 assert(!s.projects(old)&&!s.threads(old)&&!s.previewContractReady_);
 assert(s.projectCount_==3&&s.previewThreadCount_==2); // stale rows stay readable, never committed
 auto wrong=valid;wrong["environmentId"].value="envA";
 assert(!s.projects(wrong)&&!s.threads(wrong));
 auto folder=valid;folder["projectId"].value="folderA";assert(!s.threads(folder));
 auto bad=valid;bad["threads"].array=false;assert(!s.threads(bad));
 Node result;result["config"]["environmentId"].value="envB";result["config"]["projectId"].value="folderB";result["config"]["threadId"].value="threadB";
 assert(s.commit(result));result["config"]["projectId"].value="folderA";assert(!s.commit(result));
 assert(!s.created(result) && s.created_.id.empty());
 result["config"]["projectId"].value="folderB";result["config"]["threadId"].value="other";assert(!s.commit(result));
 assert(!s.created(result));result["config"]["threadId"].value="threadB";assert(s.created(result));
}
`);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});
