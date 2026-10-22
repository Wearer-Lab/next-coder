import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("OTA decoded stream bounds every partition write and rejects incomplete, overflowing, or failed streams", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const dir = await mkdtemp(join(tmpdir(), "next-coder-ota-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "mbedtls"));
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayOta.cpp", "utf8");
  const deadlineClient = source.slice(source.indexOf("template <typename Client>"), source.indexOf("String hexDigest("));
  await writeFile(join(dir, "Arduino.h"), `#pragma once
#include <cstdint>
#include <cstddef>
inline uint32_t nowMs=0;
inline uint32_t millis() { return nowMs; }
inline void delay(unsigned) {}
class Stream { public: virtual ~Stream()=default; virtual size_t write(uint8_t)=0; virtual size_t write(const uint8_t*,size_t)=0; virtual int available()=0; virtual int read()=0; virtual int peek()=0; virtual void flush()=0; };
`);
  await writeFile(join(dir, "Update.h"), `#pragma once
struct UpdateStub { size_t bytes=0; bool fail=false; size_t write(uint8_t*,size_t n) { if(fail) return 0; bytes+=n; return n; } }; inline UpdateStub Update;
`);
  await writeFile(join(dir, "mbedtls/sha256.h"), `#pragma once
#include <cstdint>
#include <cstddef>
struct mbedtls_sha256_context { unsigned sum=0; };
inline bool hashFail=false; inline int contexts=0;
inline void mbedtls_sha256_init(mbedtls_sha256_context*) { ++contexts; }
inline int mbedtls_sha256_starts(mbedtls_sha256_context*,int) { return 0; }
inline int mbedtls_sha256_update(mbedtls_sha256_context* c,const uint8_t* b,size_t n) { if(hashFail)return -1; for(size_t i=0;i<n;++i)c->sum+=b[i]; return 0; }
inline int mbedtls_sha256_finish(mbedtls_sha256_context* c,uint8_t* b) { b[0]=c->sum; return hashFail ? -1 : 0; }
inline void mbedtls_sha256_free(mbedtls_sha256_context*) { --contexts; }
`);
  await writeFile(join(dir, "check.cpp"), `#include <cassert>
#include "OtaDownloadSink.h"
namespace gateway_http { template<class Client> using YieldingClient = Client; }
struct Socket {
 bool stopped=false;
 virtual ~Socket()=default;
 virtual int available() { return 5; }
 virtual int read() { return 1; }
 virtual int read(uint8_t*,size_t n) { return n; }
 void stop() { stopped=true; }
};
${deadlineClient}
int main() {
 uint8_t b[]={1,2,3,4,5}, digest[32]{};
 { OtaDownloadSink sink(4); assert(sink.write(b,1)==1); assert(sink.write(b+1,3)==3); assert(sink.finish(digest)); assert(digest[0]==10 && Update.bytes==4); }
 assert(contexts==0);
 { OtaDownloadSink sink(4); assert(sink.write(b,5)==0); assert(!sink.finish(digest) && Update.bytes==4); assert(sink.write(b,1)==0); }
 { OtaDownloadSink sink(4); assert(sink.write(b,2)==2); assert(!sink.finish(digest)); }
 { Update.fail=true; OtaDownloadSink sink(4); assert(sink.write(b,4)==0 && !sink.finish(digest)); Update.fail=false; }
 { hashFail=true; auto before=Update.bytes; OtaDownloadSink sink(4); assert(sink.write(b,4)==0 && !sink.finish(digest)); assert(Update.bytes==before); hashFail=false; }
 assert(contexts==0);
 { nowMs=10; OtaDeadlineClient<Socket> socket(20); assert(socket.read()==1 && socket.available()==5); nowMs=20; assert(socket.read()==-1 && socket.stopped); assert(socket.available()==0); assert(socket.read(b,5)==-1); }
 { nowMs=0xfffffff0; OtaDeadlineClient<Socket> socket(20); assert(socket.read()==1); nowMs=21; assert(socket.available()==0 && socket.stopped); }
}
`);
  const exe = join(dir, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", "-I", dir, "-I", resolve("firmware/shared/NextCoderCore/src"), join(dir, "check.cpp"), "-o", exe], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const run = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
