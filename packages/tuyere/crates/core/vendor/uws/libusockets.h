/* Stand-in for uSockets' header: WebSocketProtocol.h only needs the size of the receive buffer its unmasking fast path
 * assumes. Tuyere reads into buffers smaller than this, so that fast path is never taken. */
#pragma once
#define LIBUS_RECV_BUFFER_LENGTH 524288
