Vendored unchanged Project Nayuki C QR encoder (MIT license retained in each file).

Upstream: https://github.com/nayuki/QR-Code-generator
Revision: 3c6d0b3cefb4e049dc337e82237c9644399716a8

- qrcodegen.c SHA-256: 6a2b9cc65176f2345dde260c74b6d352627e8a0a6385d086ae0e9c5d0913c70c
- qrcodegen.h SHA-256: e82df4bff37d18b5863b9e7486fe6bda1b6cda8c3b9ecebfec473907265cb589

SetupQr restricts the encoder to version 5 with two fixed 173-byte work buffers.
The encoder is pure and reentrant; there is no SDK display callback or shared scratch state.
Render a white 128-pixel square, then black module runs using Matrix::scale()/offset().
Preserve the four-module quiet zone. Never recolor, antialias, stretch or cover the QR modules.
