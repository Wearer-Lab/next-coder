#pragma once

#include <stddef.h>

// One gateway page can need multiple local pages after word wrapping for a narrower display.
// Walk the bounded input twice and retain only the requested screen's lines; no dynamic list or
// silent max-lines truncation. Text is Arduino String (a compatible facade is used in native tests).
struct ResponseLayout {
  size_t page = 0;
  size_t pageCount = 1;
  size_t totalLines = 0;
  size_t lineCount = 0;
};

template <class Text>
ResponseLayout layoutResponsePage(const Text* source, size_t sourceCount,
                                  size_t columns, size_t rows, size_t requestedPage,
                                  Text* output, size_t outputCapacity) {
  ResponseLayout result;
  if (!source || !output || columns == 0 || rows == 0 || outputCapacity == 0) return result;
  if (rows > outputCapacity) rows = outputCapacity;
  Text joined;
  for (size_t i = 0; i < sourceCount; ++i) {
    if (source[i].length() == 0) continue;
    if (joined.length() > 0) joined += ' ';
    joined += source[i];
  }
  const size_t length = joined.length();
  auto walk = [&](bool collect) {
    size_t index = 0, line = 0;
    while (index < length) {
      while (index < length && joined[index] == ' ') ++index;
      if (index == length) break;
      size_t end = length - index < columns ? length : index + columns;
      if (end < length) {
        size_t space = end;
        while (space > index && joined[space] != ' ') --space;
        if (space > index) end = space;
      }
      if (collect && line / rows == result.page && result.lineCount < rows) {
        output[result.lineCount++] = joined.substring(index, end);
      }
      ++line;
      index = end;
    }
    return line;
  };
  result.totalLines = walk(false);
  result.pageCount = result.totalLines == 0 ? 1 : (result.totalLines + rows - 1) / rows;
  result.page = requestedPage < result.pageCount ? requestedPage : result.pageCount - 1;
  walk(true);
  for (size_t i = result.lineCount; i < outputCapacity; ++i) output[i] = "";
  return result;
}
