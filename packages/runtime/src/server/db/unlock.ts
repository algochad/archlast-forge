// Writers of one database file in several processes (a cluster of servers) tell each other when they let go of the write lock, so a writer that waits for it wakes at
// once instead of polling. `send` is set by the cluster (cluster.ts), which carries the message; a server on its own never sets it.
export const unlock = {
  send: (() => {}) as () => void,
  waiters: new Set<() => void>(),
  /** Another server let go of the write lock. */
  notify() {
    for (const wake of [...this.waiters]) wake();
  },
};
