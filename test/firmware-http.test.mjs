import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("gateway HTTP waits yield to the scheduler and decoded bodies cannot exceed their memory bound", async (t) => {
  const compiler = process.env.CXX || "c++";
  const available = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") return t.skip("A native C++ compiler is unavailable.");
  assert.equal(available.status, 0);
  const directory = await mkdtemp(join(tmpdir(), "next-coder-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A host Arduino boundary lets the actual shared template and sink run under a native compiler.
  await writeFile(join(directory, "Arduino.h"), `#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
inline unsigned yields = 0;
inline void delay(unsigned ms) { if (ms) ++yields; }
class String {
 public:
  std::string value;
  bool allocationFails = false;
  String& operator=(const char* text) { value = text; return *this; }
  size_t length() const { return value.length(); }
  bool concat(const char* bytes, size_t size) { if (allocationFails) return false; value.append(bytes, size); return true; }
};
class Stream {
 public:
  virtual ~Stream() = default;
  virtual size_t write(uint8_t) = 0;
  virtual size_t write(const uint8_t*, size_t) = 0;
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  virtual void flush() = 0;
};
`);
  await writeFile(join(directory, "check.cpp"), `#include <cassert>
#include "GatewayHttp.h"
struct Socket {
  virtual ~Socket() = default;
  int next = -1;
  virtual int read() { return next; }
  size_t read(uint8_t*, size_t) { return 0; }
};
int main() {
  gateway_http::YieldingClient<Socket> client;
  Socket& socket = client;
  for (int i = 0; i < 100; ++i) assert(socket.read() == -1);
  assert(yields == 100);
  client.next = 'x';
  assert(socket.read() == 'x' && yields == 100);
  String output;
  gateway_http::BoundedBody sink(output, 4);
  const uint8_t body[] = {'a', 'b', 'c', 'd', 'e'};
  assert(sink.write(body, 3) == 3);
  assert(sink.write(body + 3, 1) == 1);
  assert(output.value == "abcd");
  assert(sink.write(body + 4, 1) == 0 && sink.failed());
  assert(sink.write(body, 1) == 0 && output.value == "abcd");
  gateway_http::BoundedBody allocation(output, 4);
  output.allocationFails = true;
  assert(allocation.write(body, 1) == 0 && allocation.failed());
  gateway_http::BoundedBody single(output, 0);
  assert(single.write(uint8_t('x')) == 0 && single.failed());
}
`);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", directory,
    "-I", resolve("firmware/shared/NextCoderCore/src"), join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});
