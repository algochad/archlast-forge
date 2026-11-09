# uWebSockets protocol layer

`WebSocketProtocol.h` is from Bun's vendored copy of uWebSockets (oven-sh/bun, `packages/bun-uws/src`, tag bun-v1.4.4),
which is uNetworking/uWebSockets with Bun's fixes (explicit masking checks, structured failure kinds). `WebSocketHandshake.h`
is from uNetworking/uWebSockets (Apache-2.0, see LICENSE) because Bun's copy uses BoringSSL for SHA-1/base64.
Both are used unmodified. The stand-in headers `libusockets.h` and `wtf/SIMDUTF.h` replace uSockets and simdutf.
Only the protocol layer is used (frame parsing, unmasking, frame formatting, close payloads, handshake key): uWebSockets'
App and sockets need their own event loop, while this engine's I/O stays on hyper and tokio.
