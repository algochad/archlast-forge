import { useAuth } from "@archlast-forge/react";
import { useNavigate } from "@archlast-forge/framework";
import { useState, type FormEvent } from "react";

export default function SignIn() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const res = await auth.signUp.email({ email, password: String(f.get("password")), name: email.split("@")[0]! });
    if (res.error) return setError(res.error.message);
    await navigate("/secret");
  }
  return (
    <form id="sign-in" onSubmit={submit}>
      <input name="email" type="email" aria-label="Email" required />
      <input name="password" type="password" aria-label="Password" required />
      <button>Sign up</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
