import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

/** CPU cores this process may use: the container's CPU quota when it has one (cgroup v2 `cpu.max`), else the machine's. */
export function serverCores(): number {
  const cores = availableParallelism();
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota && quota !== "max") return Math.min(cores, Math.max(1, Math.ceil(Number(quota) / Number(period))));
  } catch {} // not Linux, or no cgroup v2
  return cores;
}
