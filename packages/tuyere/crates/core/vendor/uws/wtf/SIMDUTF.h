/* Stand-in for Bun's simdutf include: UTF-8 validation is provided by the host (see uws_shim.cpp). */
#pragma once
#include <cstddef>
namespace simdutf {
bool validate_utf8(const char *buf, size_t len) noexcept;
}
