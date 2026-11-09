#!/bin/bash
# Builds both native backends and copies them to ./native (Linux).
set -e
cd "$(dirname "$0")"
cargo build --release
mkdir -p native
cp target/release/libtuyere_ffi.so native/tuyere_ffi.so
cp target/release/libtuyere_napi.so native/tuyere.node
echo "built: $(ls native | tr '\n' ' ')"
