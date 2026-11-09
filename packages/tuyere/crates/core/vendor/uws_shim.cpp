// A C face for uWebSockets' WebSocket protocol layer (frame parser/formatter), driven from Rust. No allocation, no
// exceptions, no libstdc++ symbols: everything here is header templates and memcpy.
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <new>
#include "WebSocketProtocol.h"
#include "WebSocketHandshake.h"

extern "C" bool archlast_utf8_valid(const char *s, size_t n);

namespace simdutf {
bool validate_utf8(const char *buf, size_t len) noexcept { return archlast_utf8_valid(buf, len); }
}

extern "C" {

struct uws_cb {
    void *user;
    int (*set_compressed)(void *user);
    int (*refuse_length)(void *user, uint64_t length);
    int (*fragment)(void *user, char *data, size_t length, unsigned int remaining, int opcode, int fin);
    void (*fail)(void *user, int kind, unsigned int close_code, uint64_t detail, const char *diag, size_t diag_len);
};

struct uws_close_info {
    uint16_t code;
    const char *message;
    size_t message_len;
    int failed;
    uint16_t fail_close_code;
    int fail_kind;
    const char *diag;
    size_t diag_len;
};

}

using namespace uWS;

namespace {
struct Impl {
    static bool setCompressed(WebSocketState<true> *, void *u) { auto *cb = (uws_cb *) u; return cb->set_compressed(cb->user) != 0; }
    static bool refusePayloadLength(uint64_t length, WebSocketState<true> *, void *u) { auto *cb = (uws_cb *) u; return cb->refuse_length(cb->user, length) != 0; }
    static bool handleFragment(char *data, size_t length, unsigned int remaining, int opCode, bool fin, WebSocketState<true> *, void *u) {
        auto *cb = (uws_cb *) u;
        return cb->fragment(cb->user, data, length, remaining, opCode, fin ? 1 : 0) != 0;
    }
    static void failConnection(WebSocketState<true> *, void *u, const WebSocketFailure &f, uint64_t detail = 0) {
        auto *cb = (uws_cb *) u;
        cb->fail(cb->user, (int) f.kind, f.closeCode, detail, f.diagnostic.data(), f.diagnostic.size());
    }
};
}

extern "C" {

void *uws_state_new() { void *p = malloc(sizeof(WebSocketState<true>)); return p ? new (p) WebSocketState<true>() : nullptr; }
void uws_state_free(void *s) { free(s); }

void uws_consume(void *state, char *src, unsigned int length, uws_cb *cb) {
    WebSocketProtocol<true, Impl>::consume(src, length, (WebSocketState<true> *) state, cb);
}

size_t uws_pre_padding() { return WebSocketProtocol<true, Impl>::CONSUME_PRE_PADDING; }
size_t uws_post_padding() { return WebSocketProtocol<true, Impl>::CONSUME_POST_PADDING; }

size_t uws_frame_size(size_t n) { return protocol::messageFrameSize(n); }

size_t uws_format(char *dst, const char *src, size_t length, int opcode, int compressed, int fin) {
    return protocol::formatMessage<true>(dst, src, length, (OpCode) opcode, length, compressed != 0, fin != 0);
}

size_t uws_format_close(char *dst, uint16_t code, const char *message, size_t length) {
    return protocol::formatClosePayload(dst, code, message, length);
}

void uws_parse_close(char *src, size_t length, uws_close_info *out) {
    protocol::CloseFrame f = protocol::parseClosePayload(src, length, false);
    out->code = f.code;
    out->message = f.message.data();
    out->message_len = f.message.size();
    out->failed = f.failure != nullptr;
    out->fail_close_code = f.failure ? f.failure->closeCode : 0;
    out->fail_kind = f.failure ? (int) f.failure->kind : 0;
    out->diag = f.failure ? f.failure->diagnostic.data() : nullptr;
    out->diag_len = f.failure ? f.failure->diagnostic.size() : 0;
}

void uws_accept_key(const char *key24, char *out28) { WebSocketHandshake::generate(key24, out28); }

}
