import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('device Wi-Fi keyboard covers printable passphrases with two scrolling rows and WPA validation',async t=>{
 const compiler=process.env.CXX||'c++';if(spawnSync(compiler,['--version']).error?.code==='ENOENT')return t.skip('Native compiler unavailable');
 const dir=await mkdtemp(join(tmpdir(),'hosyond-wifi-keyboard-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const code=`#include <cassert>\n#include <string>\n#include <set>\n#include "wifi_keyboard.h"\nint main(){
 std::set<char> chars{' '};
 for(bool symbols:{false,true})for(bool upper:{false,true})for(size_t row=0;row<2;++row)
 for(size_t col=0;col<wifiKeyboardColumns(symbols);++col){char c=wifiKeyboardLetter(symbols,upper,col,row);if(c)chars.insert(c);}
 for(char c=32;c<127;++c)assert(chars.count(c)==1);
 assert(wifiKeyboardLetter(false,false,13,0)==0);assert(wifiKeyboardLetter(true,false,0,2)==0);
 assert(!wifiPassphraseValid(std::string(7,'a')));assert(wifiPassphraseValid(std::string(8,'a')));
 assert(wifiPassphraseValid(std::string(63,'!')));assert(!wifiPassphraseValid(std::string(64,'g')));
 assert(wifiPassphraseValid(std::string(64,'A')));assert(!wifiPassphraseValid(std::string(65,'a')));
}`;
 await writeFile(join(dir,'test.cpp'),code);const built=spawnSync(compiler,['-std=c++17','-I',resolve('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src'),join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);const run=spawnSync(join(dir,'test'),[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
});
