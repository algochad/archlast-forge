#!/bin/bash
# usage: cpu-median.sh label port path rate envs... -- cmd...   -> median of 3 fixed-rate runs (us/req), plus the 3 values
label=$1; shift
vals=()
for i in 1 2 3; do
  line=$("$(dirname "$0")/cpu-at-rate.sh" "$label" "$@")
  vals+=($(echo "$line" | grep -oE '[0-9.]+ us/req' | cut -d' ' -f1))
done
sorted=($(printf '%s\n' "${vals[@]}" | sort -n))
printf '%-34s median %5s us/req   (runs: %s)\n' "$label" "${sorted[1]}" "${vals[*]}"
