import { redirect, useNavigate, type LoaderArgs } from "@archlast-forge/framework";
import { useAuth } from "@archlast-forge/react";
import { useState, type FormEvent } from "react";

export const loader = async ({ ctx }: LoaderArgs) => {
  if (await ctx.viewer()) throw redirect("/chat");
  return null;
};

export default function SignIn() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setBusy(true);
    setError(undefined);
    const res = creating
      ? await auth.signUp.email({ email, password, name: String(form.get("name") || email.split("@")[0]) })
      : await auth.signIn.email({ email, password });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "That didn't work");
    await navigate("/chat");
  }

  return (
    <main className="narrow form-card card">
      <title>{creating ? "Create account" : "Sign in"}</title>
      <h1>{creating ? "Create your account" : "Welcome back"}</h1>
      <form onSubmit={submit}>
        {creating && (
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" autoComplete="name" />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete={creating ? "new-password" : "current-password"} minLength={8} required />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" style={{ width: "100%" }} disabled={busy}>{busy ? "One moment…" : creating ? "Create account" : "Sign in"}</button>
      </form>
      <p className="switch">
        {creating ? "Already have an account? " : "New here? "}
        <button type="button" onClick={() => (setCreating(!creating), setError(undefined))}>{creating ? "Sign in" : "Create an account"}</button>
      </p>
    </main>
  );
}
