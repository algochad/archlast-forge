import { defineAuth } from "../../src/index";

// Better Auth's own limits stay on (they are on outside dev): 3 sign-ins per 10 seconds per address.
export default defineAuth({ emailAndPassword: { enabled: true } });
