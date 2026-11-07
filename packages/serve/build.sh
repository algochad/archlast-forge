#!/bin/bash
# Builds both native backends and copies them to ./native (Linux).
set -e
cd "$(dirname "$0")"
cargo build --release
mkdir -p native
cp target/release/libarchlast_serve_ffi.so native/archlast_serve_ffi.so
cp target/release/libarchlast_serve_napi.so native/archlast_serve.node
echo "built: $(ls native | tr '\n' ' ')"
