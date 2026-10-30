import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('actual internal band compositor publishes completed clipped strips and reuses its fixed buffer',async t=>{
 const compiler=process.env.CXX||'c++';if(spawnSync(compiler,['--version']).error?.code==='ENOENT')return t.skip('Native compiler unavailable');
 const dir=await mkdtemp(join(tmpdir(),'hosyond-compositor-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=await readFile('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/display.cpp','utf8');
 const start=source.indexOf('bool displayComposeBands('),end=source.indexOf('\nnamespace {\nstruct SceneCall',start);
 const operation=source.slice(start,end);
 assert.doesNotMatch(operation,/\b(?:malloc|calloc|realloc|new)\b/u);
 const code=`#include <cassert>
#include <cstdint>
#include <cstddef>
#include <vector>
#include <algorithm>
struct Adafruit_GFX {
 uint16_t guardA=0x1234,pixels[240*22]{},guardB=0x5678;
 void setRotation(int){}void setFont(void*){}void setTextWrap(bool){}void setTextSize(int){}void setCursor(int,int){}void setTextColor(uint16_t){}
 void fillScreen(uint16_t value){std::fill(pixels,pixels+240*22,value);}
 void drawPixel(int x,int y,uint16_t value){if(x>=0&&x<240&&y>=0&&y<22)pixels[y*240+x]=value;}
 uint16_t* getBuffer(){return pixels;}
};
struct Adafruit_ILI9341 {
 struct Window{int y,rows;};std::vector<Window> windows;std::vector<uint16_t> published;
 bool writing=false;bool callbackComplete=false;
 void startWrite(){assert(callbackComplete);assert(!writing);writing=true;}
 void setAddrWindow(int x,int y,int width,int rows){assert(x==0&&width==240);windows.push_back({y,rows});}
 void endWrite(){assert(writing);writing=false;}
};
using DisplayBandPainter=void(*)(Adafruit_GFX&,int16_t,void*);
Adafruit_GFX canvas;Adafruit_GFX* labelCanvas=&canvas;
uint16_t rowBuffer[240];uint16_t* dmaRow=rowBuffer;
bool ready=true,composingBands=false;constexpr int kLabelH=22;
Adafruit_ILI9341 panel;
bool displayReady(){return ready;}
Adafruit_ILI9341& displayPanel(){return panel;}
void pushRow(Adafruit_ILI9341& target,const uint16_t* src,int16_t width){
 assert(target.writing&&width==240);std::copy(src,src+width,dmaRow);
 target.published.insert(target.published.end(),dmaRow,dmaRow+width);
}
${operation}
int calls=0;
void draw(Adafruit_GFX& target,int16_t top,void*){
 ++calls;panel.callbackComplete=false;
 assert(!displayComposeBands(0,1,0,draw,nullptr)); // reentrancy cannot corrupt the shared canvas
 for(int absoluteY=10;absoluteY<70;++absoluteY)for(int x=-2;x<242;++x)target.drawPixel(x,absoluteY-top,static_cast<uint16_t>(absoluteY));
 panel.callbackComplete=true;
}
void reset(){panel.windows.clear();panel.published.clear();calls=0;}
int main(){
 assert(displayComposeBands(10,60,0,draw,nullptr));assert(calls==3);
 assert(panel.windows.size()==3&&panel.windows[0].y==10&&panel.windows[0].rows==22&&panel.windows[2].y==54&&panel.windows[2].rows==16);
 assert(panel.published.size()==240*60);
 for(size_t i=0;i<panel.published.size();++i)assert(panel.published[i]==10+i/240);
 assert(canvas.guardA==0x1234&&canvas.guardB==0x5678&&!composingBands);
 reset();assert(displayComposeBands(-5,10,0xabcd,draw,nullptr));assert(calls==1&&panel.windows[0].y==0&&panel.windows[0].rows==5);
 assert(panel.published.size()==240*5);for(auto pixel:panel.published)assert(pixel==0xabcd);
 reset();assert(displayComposeBands(319,60,0,draw,nullptr));assert(panel.windows[0].rows==1&&panel.published.size()==240);
 reset();assert(!displayComposeBands(320,1,0,draw,nullptr));assert(!displayComposeBands(0,0,0,draw,nullptr));assert(!displayComposeBands(0,1,0,nullptr,nullptr));
 ready=false;assert(!displayComposeBands(0,1,0,draw,nullptr));ready=true;
 auto saved=dmaRow;dmaRow=nullptr;assert(!displayComposeBands(0,1,0,draw,nullptr));dmaRow=saved;
 assert(panel.windows.empty()&&calls==0);
}
`;
 await writeFile(join(dir,'check.cpp'),code);const binary=join(dir,'check');
 const compiled=spawnSync(compiler,['-std=c++17','-Wall','-Wextra','-Werror',join(dir,'check.cpp'),'-o',binary],{encoding:'utf8'});assert.equal(compiled.status,0,compiled.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
});

test('actual scene proxy clips absolute GFX/raster writes and computes soft shapes only inside its band',async t=>{
 const compiler=process.env.CXX||'c++';if(spawnSync(compiler,['--version']).error?.code==='ENOENT')return t.skip('Native compiler unavailable');
 const dir=await mkdtemp(join(tmpdir(),'hosyond-scene-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=await readFile('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/display.cpp','utf8');
 const proxy=source.slice(source.indexOf('// BEGIN ABSOLUTE SCENE PROXY'),source.indexOf('// END ABSOLUTE SCENE PROXY'));
 const routes=source.slice(source.indexOf('void clipSceneBand('),source.indexOf('// Copies `len` pixels'));
 const access=source.slice(source.indexOf('Adafruit_GFX& displayRenderGfx()'),source.indexOf('bool displayBeginCanvases('));
 const start=source.indexOf('void displaySoftRoundRectBand(');
 const kernel=source.slice(start,source.indexOf('\nvoid displaySoftRoundRect(',start));
 const apiStart=source.indexOf('\nnamespace {\nstruct SceneCall');
 const api=source.slice(apiStart,source.indexOf('\nvoid displayDrawStatus(',apiStart));
 const code=`#include <cassert>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <cmath>
#include <algorithm>
struct Adafruit_GFX {
 Adafruit_GFX(int,int){}virtual ~Adafruit_GFX()=default;
 virtual void drawPixel(int16_t,int16_t,uint16_t){}
 virtual void writePixel(int16_t x,int16_t y,uint16_t c){drawPixel(x,y,c);}
 virtual void fillRect(int16_t,int16_t,int16_t,int16_t,uint16_t){}
 virtual void writeFillRect(int16_t x,int16_t y,int16_t w,int16_t h,uint16_t c){fillRect(x,y,w,h,c);}
 virtual void drawFastHLine(int16_t,int16_t,int16_t,uint16_t){}
 virtual void drawFastVLine(int16_t,int16_t,int16_t,uint16_t){}
 virtual void writeFastHLine(int16_t,int16_t,int16_t,uint16_t){}
 virtual void writeFastVLine(int16_t,int16_t,int16_t,uint16_t){}
 void setRotation(int){}void setFont(void*){}void setTextWrap(bool){}void setTextSize(int){}void setCursor(int,int){}
};
struct Canvas {uint16_t before=0x1234,pixels[240*22]{},after=0x5678;uint16_t* getBuffer(){return pixels;}} canvas;
Canvas* labelCanvas=&canvas;
struct Adafruit_ILI9341:Adafruit_GFX{
 int calls=0;Adafruit_ILI9341():Adafruit_GFX(240,320){}
 void startWrite(){++calls;}void endWrite(){++calls;}void setAddrWindow(int,int,int,int){++calls;}
 void writePixels(uint16_t*,int){++calls;}
} panel;
Adafruit_ILI9341& displayPanel(){return panel;}
bool displayReady(){return true;}
constexpr int kLabelH=22,kPanelW=240,kPanelH=320;
uint16_t dmaMemory[240];uint16_t* dmaRow=dmaMemory;
${proxy}
${routes}
${access}
int mathCalls=0;
float roundBoxSdf(float,float,float,float,float){++mathCalls;return 0;}
float clamp01(float x){return x<0?0:x>1?1:x;}
float over(float base,float ink,float weight){return base+(ink-base)*weight;}
uint16_t panelGrey(uint8_t x){return x;}
${kernel}
using DisplayScenePainter=void(*)(void*);
using DisplayBandPainter=void(*)(Adafruit_GFX&,int16_t,void*);
bool composingBands=false;
int bands=0;
bool displayComposeBands(int16_t y,int16_t height,uint16_t,DisplayBandPainter painter,void* context){
 if(composingBands)return false;
 composingBands=true;
 for(int top=std::max<int>(0,y);top<std::min<int>(320,y+height);top+=22){
  std::fill(canvas.pixels,canvas.pixels+240*22,0);painter(sceneGfx,top,context);++bands;
 }
 composingBands=false;return true;
}
${api}
void replay(void*){
 assert(displaySceneActive());
 assert(!displayComposeScene(0,1,0,replay,nullptr));
 displayRenderGfx().fillRect(10,30,20,40,0xabcd);
}
int main(){
 assert(&displayRenderGfx()==static_cast<Adafruit_GFX*>(&panel));
 sceneActive=true;sceneBandTop=50;sceneBandBottom=72;
 assert(&displayRenderGfx()==static_cast<Adafruit_GFX*>(&sceneGfx));
 sceneGfx.fillRect(-100,-100,1000,1000,0x1111);
 for(auto pixel:canvas.pixels)assert(pixel==0x1111);
 sceneGfx.drawPixel(-1,50,0xffff);sceneGfx.drawPixel(240,50,0xffff);sceneGfx.drawPixel(0,49,0xffff);sceneGfx.drawPixel(0,72,0xffff);
 sceneGfx.writeFastHLine(230,71,50,0x2222);assert(canvas.pixels[21*240+239]==0x2222);
 sceneGfx.writeFastVLine(0,0,320,0x3333);assert(canvas.pixels[0]==0x3333&&canvas.pixels[21*240]==0x3333);
 assert(!displayRenderIntersects(0,0,240,50));assert(displayRenderIntersects(0,49,240,2));
 int16_t first=0,last=320;clipSceneBand(first,last);assert(first==50&&last==72);
 for(int i=0;i<240;++i)dmaRow[i]=static_cast<uint16_t>(i);
 publishRasterRow(-3,50,10);assert(canvas.pixels[0]==3&&canvas.pixels[6]==9);
 assert(canvas.before==0x1234&&canvas.after==0x5678);
 mathCalls=0;displaySoftRoundRectBand(0,0,240,320,4,0,100,-1,0,1,0,320);
 assert(mathCalls==240*22);assert(panel.calls==0); // no hidden clear or SPI flush from a painter
 sceneActive=false;assert(displayComposeScene(30,40,0,replay,nullptr));assert(bands==2&&!sceneActive&&!composingBands);
 assert(!displayComposeScene(0,1,0,nullptr,nullptr));
 assert(canvas.before==0x1234&&canvas.after==0x5678&&panel.calls==0);
}
`;
 await writeFile(join(dir,'check.cpp'),code);const binary=join(dir,'check');
 const compiled=spawnSync(compiler,['-std=c++17','-Wall','-Wextra','-Werror',join(dir,'check.cpp'),'-o',binary],{encoding:'utf8'});assert.equal(compiled.status,0,compiled.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
});
