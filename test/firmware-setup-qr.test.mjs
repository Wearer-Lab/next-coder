import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual setup QR encoder generates bounded quiet-zone matrices that decode to exact local URL and escaped Wi-Fi payloads", async (t) => {
  const compiler=process.env.CXX||"c++";
  if(spawnSync(compiler,["--version"]).error?.code==="ENOENT")return t.skip("Native compiler unavailable");
  const dir=await mkdtemp(join(tmpdir(),"next-coder-setup-qr-"));if(process.env.KEEP_SETUP_QR)t.diagnostic(dir);else t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=resolve("firmware/shared/NextCoderCore/src");
  const code=`
#include "SetupQr.h"
#include <cassert>
#include <cstring>
#include <fstream>
#include <chrono>
#include <iostream>
using namespace setup_qr;
void write(const char*name,const Matrix&matrix){
 assert(matrix.size>=21 && matrix.size<=37 && matrix.scale()>=2);
 assert(matrix.offset()>=kQuietModules*matrix.scale());
 std::ofstream file(name,std::ios::binary);file<<"P5\\n128 128\\n255\\n";
 for(int y=0;y<kPixels;++y)for(int x=0;x<kPixels;++x){
  const auto pixel=static_cast<unsigned char>(matrix.pixelBlack(x,y)?0:255);file.write(reinterpret_cast<const char*>(&pixel),1);
  if(x<matrix.offset() || y<matrix.offset() || x>=matrix.offset()+matrix.size*matrix.scale() || y>=matrix.offset()+matrix.size*matrix.scale())assert(pixel==255);
 }
 assert(!matrix.dark(-1,0)&&!matrix.dark(0,-1)&&!matrix.dark(matrix.size,0));
}
int main(){
 static_assert(sizeof(Matrix)<=176,"QR cache must remain bounded");
 Matrix matrix;
 assert(encodeWifi("agent-ctl-abcd-setup","ABCDEF23456789XY",matrix));write("wifi.pgm",matrix);
 assert(encodeWifi("Café;room\\\\x:\\"","Abc;:\\"\\\\123456",matrix));write("unicode.pgm",matrix);
 assert(encodeWifi("Open network","",matrix));write("open.pgm",matrix);
 assert(encodePortalUrl("http://192.168.4.1",matrix));write("url.pgm",matrix);
 assert(!encodePortalUrl("https://evil.test",matrix));assert(matrix.size==0);
 assert(!encodePortalUrl("http://192.168.4.1.evil.test",matrix));assert(matrix.size==0);
 assert(!encodePortalUrl("http://192.168.4.1@evil.test",matrix));assert(matrix.size==0);
 assert(!encodeWifi("bad\\nnetwork","password",matrix));assert(matrix.size==0);
 assert(!encodeWifi(nullptr,"password",matrix));assert(matrix.size==0);
 char ssid[33],password[65];memset(ssid,'\\\\',32);ssid[32]=0;memset(password,'\\\\',64);password[64]=0;
 assert(!encodeWifi(ssid,password,matrix));assert(matrix.size==0);for(auto byte:matrix.bits)assert(byte==0);
 assert(encodePortalUrl("http://192.168.4.1/",matrix));matrix.clear();assert(matrix.size==0);for(auto byte:matrix.bits)assert(byte==0);
 const auto begin=std::chrono::steady_clock::now();
 for(int i=0;i<100;++i)assert(encodeWifi("agent-ctl-abcd-setup","ABCDEF23456789XY",matrix));
 std::cout<<"encoder_us_per_call="<<std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-begin).count()/100<<" modules="<<static_cast<int>(matrix.size)<<" scale="<<matrix.scale()<<" matrix_bytes="<<sizeof(matrix)<<"\\n";
}
`;
  await writeFile(join(dir,"check.cpp"),code);
  const object=join(dir,"encoder.o");
  const c=spawnSync(process.env.CC||"cc",["-std=c99","-O2","-c",join(root,"third_party/qrcodegen/qrcodegen.c"),"-o",object],{encoding:"utf8"});assert.equal(c.status,0,c.stderr);
  const compiled=spawnSync(compiler,["-std=c++17","-O2","-I",root,join(root,"SetupQr.cpp"),join(dir,"check.cpp"),object,"-o",join(dir,"check")],{encoding:"utf8"});assert.equal(compiled.status,0,compiled.stderr);
  const run=spawnSync(join(dir,"check"),[],{cwd:dir,encoding:"utf8"});assert.equal(run.status,0,run.stderr);t.diagnostic(run.stdout.trim());
  const python=process.env.PYTHON||"python3";
  const available=spawnSync(python,["-c","import cv2"],{encoding:"utf8"});
  if(available.status!==0){t.diagnostic("OpenCV unavailable: native matrix invariants passed, decode verification not run.");return;}
  const decoded=spawnSync(python,["-c",`import cv2,json
values={}
for name in ['wifi','unicode','open','url']:
 image=cv2.imread(name+'.pgm',cv2.IMREAD_GRAYSCALE)
 value,points,_=cv2.QRCodeDetector().detectAndDecode(image)
 if not value and hasattr(cv2,'QRCodeDetectorAruco'):
  value,points,_=cv2.QRCodeDetectorAruco().detectAndDecode(image)
 if not value:
  image=cv2.resize(image,None,fx=4,fy=4,interpolation=cv2.INTER_NEAREST)
  value,points,_=cv2.QRCodeDetector().detectAndDecode(image)
 assert value, name+' generated QR did not decode'
 values[name]=value
print(json.dumps(values,ensure_ascii=False))`],{cwd:dir,encoding:"utf8"});
  assert.equal(decoded.status,0,decoded.stderr);
  const result=JSON.parse(decoded.stdout);
  assert.equal(result.wifi,"WIFI:T:WPA;S:agent-ctl-abcd-setup;P:ABCDEF23456789XY;;");
  assert.equal(result.unicode,'WIFI:T:WPA;S:Café\\;room\\\\x\\:\\";P:Abc\\;\\:\\"\\\\123456;;');
  assert.equal(result.open,"WIFI:T:nopass;S:Open network;P:;;");
  assert.equal(result.url,"http://192.168.4.1");
  t.diagnostic("OpenCV classical/Aruco decoders decoded all four generated 128px QR payloads exactly (URL, WPA setup AP, open network and UTF-8/escaped fields).");
});
