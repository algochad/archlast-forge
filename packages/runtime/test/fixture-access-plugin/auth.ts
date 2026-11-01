import { admin } from "better-auth/plugins";
import { defineAuth } from "../../src/index";

// A plugin turns off the engine's own fast session path, so every caller is resolved by Better Auth: the case most real apps are in.
export default defineAuth({ emailAndPassword: { enabled: true }, rateLimit: { enabled: false }, plugins: [admin()] });
