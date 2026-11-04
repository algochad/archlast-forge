#!/usr/bin/env bash
# The whole matrix: the control first, then three runs of every config, then the control again. Output: results/results.jsonl
cd "$(dirname "$0")"
node matrix.mjs --configs control --control 1 --runs 3 --out results/results.jsonl
node matrix.mjs --runs 3 --out results/results.jsonl
node matrix.mjs --configs control --control 1 --runs 3 --out results/results-control-end.jsonl
