import { useNavigate } from "@archlast/forge-framework";
import { useAuth } from "@archlast/forge-react";

/**
 * The signed-in visitor's menu. It is an island: it needs the browser (a click handler and the auth client), so it is its own component in its own file, and its
 * props are plain data. app/root.tsx renders it only for a signed-in visitor, so a visitor who is not has a page with no JavaScript of its own.
 */
export function UserMenu({ name }: { name: string }) {
  const auth = useAuth();
  const navigate = useNavigate();

  async function signOut() {
    await auth.signOut();
    await navigate("/");
  }

  return (
    <div className="who">
      <span className="avatar" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>
      <span>{name}</span>
      <button className="btn small" onClick={signOut}>Sign out</button>
    </div>
  );
}
