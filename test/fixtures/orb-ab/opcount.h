#pragma once
// Force-included into the candidate build only. Counts the libm calls that the ESP32-S3 has to
// run as real function calls (it has float add/mul/madd and a hardware sqrt seed, nothing else),
// so a change can be judged by how many it removes before anyone flashes it.
#include <cmath>
#include <math.h>
enum OpKind { kSin, kCos, kSqrt, kFloor, kCeil, kFmod, kExp, kPow, kLround, kOpKinds };
extern unsigned long gOps[kOpKinds];
inline float op_sinf(float x) { ++gOps[kSin]; return std::sin(x); }
inline float op_cosf(float x) { ++gOps[kCos]; return std::cos(x); }
inline float op_sqrtf(float x) { ++gOps[kSqrt]; return std::sqrt(x); }
inline float op_floorf(float x) { ++gOps[kFloor]; return std::floor(x); }
inline float op_ceilf(float x) { ++gOps[kCeil]; return std::ceil(x); }
inline float op_fmodf(float x, float y) { ++gOps[kFmod]; return std::fmod(x, y); }
inline float op_expf(float x) { ++gOps[kExp]; return std::exp(x); }
inline float op_powf(float x, float y) { ++gOps[kPow]; return std::pow(x, y); }
inline long op_lroundf(float x) { ++gOps[kLround]; return std::lround(x); }
#define sinf op_sinf
#define cosf op_cosf
#define sqrtf op_sqrtf
#define floorf op_floorf
#define ceilf op_ceilf
#define fmodf op_fmodf
#define expf op_expf
#define powf op_powf
#define lroundf op_lroundf
