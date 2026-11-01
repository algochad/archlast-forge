import { defineAuth } from "../../src/index";

// Sign-ups come in bursts in the tests: Better Auth's own limiter (on in production mode) would refuse them.
export default defineAuth({ emailAndPassword: { enabled: true }, rateLimit: { enabled: false } });
