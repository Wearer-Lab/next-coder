#pragma once
#include <stddef.h>

// Two horizontally scrolling rows. Each visible letter has a 56x60px target.
// Symbols include every printable non-letter ASCII character; SPACE is a stable utility key.
inline const char* wifiKeyboardAlphabet(bool symbols) {
  return symbols ? "0123456789!@#$%^&*()-_=+[]{}:;'\",.<>/?\\|`~" : "abcdefghijklmnopqrstuvwxyz";
}
inline size_t wifiKeyboardColumns(bool symbols) { return symbols ? 21 : 13; }
inline char wifiKeyboardLetter(bool symbols,bool upper,size_t column,size_t row) {
  if(column>=wifiKeyboardColumns(symbols) || row>=2)return 0;
  const size_t index=row*wifiKeyboardColumns(symbols)+column;
  const char* alphabet=wifiKeyboardAlphabet(symbols);
  size_t length=0;while(alphabet[length])++length;
  if(index>=length)return 0;
  const char value=alphabet[index];
  return !symbols && upper ? static_cast<char>(value-'a'+'A') : value;
}
template <class Text> bool wifiPassphraseValid(const Text& value) {
  if(value.length() >= 8 && value.length() <= 63)return true;
  if(value.length()!=64)return false;
  for(size_t i=0;i<64;++i) {
    const char c=value[i];
    if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F')))return false;
  }
  return true;
}
