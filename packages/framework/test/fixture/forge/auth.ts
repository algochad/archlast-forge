import { defineAuth } from "@archlast-forge/runtime";

// Tests sign users up in quick succession; Better Auth's per-path limit (3 per 10 s) is for production traffic.
export default defineAuth({ emailAndPassword: { enabled: true }, rateLimit: { enabled: false } });
