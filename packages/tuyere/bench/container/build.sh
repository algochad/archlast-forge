#!/bin/bash
# Builds the benchmark image. Forge's RPC handler and zod are copied from a checkout (FORGE_RUNTIME, default the engine worktree).
set -e
cd "$(dirname "$0")/../.."
RT=${FORGE_RUNTIME:-/home/algochad/Projects/archlast-forge-engine/packages/runtime}
rm -rf bench/container/forge && mkdir -p bench/container/forge/src bench/container/forge/node_modules
cp -r "$RT/src/forge-rpc" bench/container/forge/src/forge-rpc
cp -rL "$RT/node_modules/zod" bench/container/forge/node_modules/zod
docker build -f bench/container/Dockerfile -t archlast-bench .
