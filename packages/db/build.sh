#!/bin/bash
# Builds the native library and copies it to ./native (Linux).
set -e
cd "$(dirname "$0")"
cargo build --release
mkdir -p native
cp target/release/libarchlast_db_napi.so native/archlast_db.node
echo "built: $(ls native | tr '\n' ' ')"
