import { query, v } from "../../src/index";

/** A public function: the public REST docs leave it out (functions: false); development's complete document lists it. */
export const count = query({ args: { status: v.optional(v.string()) }, returns: v.number(), handler: async () => 0 });
