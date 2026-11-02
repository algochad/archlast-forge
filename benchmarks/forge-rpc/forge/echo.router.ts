import { Input, Mutation, Router, z } from "@archlast/forge-runtime/nest/rpc";

/** The payload back, over Forge RPC: input and output both validated, as a typed router would be. */
@Router({ alias: "echo" })
export class EchoRouter {
  @Mutation({ input: z.object({ blob: z.string() }), output: z.object({ n: z.number(), blob: z.string() }) })
  back(@Input("blob") blob: string) {
    return { n: blob.length, blob };
  }
}
