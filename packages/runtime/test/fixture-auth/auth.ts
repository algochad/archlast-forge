import { defineAuth } from "../../src/index";

// Mail never leaves the test: the reset link lands here.
export const sent: { to: string; token: string }[] = ((globalThis as any).__resetMail ??= []);

export default defineAuth({
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, token }) => {
      sent.push({ to: user.email, token });
    },
  },
  rateLimit: { enabled: false },
});
