import { Controller, Get, Query } from "@archlast/forge-runtime/nest";
import { computePool } from "@archlast/forge-runtime/pool";

/**
 * Blocking work: a chain of SHA-256 hashes, each of the last. It uses the CPU for as long as `rounds` says and nothing else.
 * The function takes only its argument, so the pool can run it on a worker thread as it is.
 */
const chain = (rounds: number) => {
  let digest = "seed";
  for (let i = 0; i < rounds; i++) digest = new Bun.CryptoHasher("sha256").update(digest).digest("hex");
  return digest;
};

// A pool made right here, from a plain function: no task module, no isMain guard.
const pool = computePool({ chain });

const rounds = (raw?: string) => Math.min(Math.max(Number(raw) || 20_000, 1), 1_000_000);

@Controller()
export class WorkController {
  /** On the thread that serves requests: every other request waits while it runs. */
  @Get("work/inline")
  inline(@Query("rounds") n?: string) {
    return { digest: chain(rounds(n)) };
  }

  /** On a worker thread: this thread goes on to the next request while it runs. */
  @Get("work/pool")
  async pooled(@Query("rounds") n?: string) {
    return { digest: await pool.call.chain(rounds(n)) };
  }

  /** Does nothing: how long it takes to answer is how busy the serving thread is. */
  @Get("ping")
  ping() {
    return { ok: true };
  }
}
