#pragma once

// Rasterises an OrbFrame into an 8-bit coverage buffer, so every board draws the same orb.
//
// ThinkingOrb produces geometry; this turns it into pixels; the board maps those pixels onto its
// own panel. Splitting it here rather than leaving it in one board's display adapter is what keeps
// the four boards visually identical — an e-paper controller and an AMOLED one should be recognisably
// the same product, and they will not be if each grows its own rasteriser.
//
// Coverage, not colour: the orb is greyscale on a uniform ground, so 0..255 per pixel says
// everything. A 16-bit panel maps it through its own palette, and a 1-bit panel thresholds it.
// That also halves the buffer against an RGB565 canvas.

#include <Arduino.h>

#include "ThinkingOrb.h"

// `grey` is `dim` x `dim`, caller-owned, and must be DMA-safe if the board pushes it directly.
// The buffer is cleared and fully redrawn each call.
void paintOrbCoverage(const OrbFrame& frame, uint8_t* grey, int16_t dim);
