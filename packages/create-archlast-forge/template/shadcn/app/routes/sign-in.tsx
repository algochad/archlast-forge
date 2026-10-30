import { redirect, useNavigate, type LoaderArgs } from "@archlast/forge-framework";
import { useAuth } from "@archlast/forge-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    <main className="mx-auto w-full max-w-sm px-4 py-16">
      <title>{creating ? "Create account" : "Sign in"}</title>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">{creating ? "Create your account" : "Welcome back"}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            {creating && (
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" type="text" autoComplete="name" />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete={creating ? "new-password" : "current-password"} minLength={8} required />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? "One moment…" : creating ? "Create account" : "Sign in"}</Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {creating ? "Already have an account? " : "New here? "}
            <button type="button" className="text-primary underline underline-offset-4" onClick={() => (setCreating(!creating), setError(undefined))}>{creating ? "Sign in" : "Create an account"}</button>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
