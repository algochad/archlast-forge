import { useState } from "react";
import { ago, canWrite, formatTime, get, post, type Admin, type Doc, type Page } from "../api";
import { Badge, Button, Drawer, Empty, ErrorNote, Field, Skeleton, useAction, useAsync } from "../ui";

type User = Doc & { email: string; name: string; emailVerified?: boolean; banned?: boolean };
type Session = Doc & { expiresAt: number; ipAddress?: string; userAgent?: string; createdAt: number };

export function Users({ admin }: { admin: Admin }) {
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<User | null>(null);
  const users = useAsync(() => get<Page<User>>("users", { email: query || undefined, cursor: cursors.at(-1), numItems: 50 }), [query, cursors.at(-1)], { interval: 10_000 });
  return (
    <section className="panel stack" aria-label="Users">
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(email.trim().toLowerCase());
          setCursors([null]);
        }}
      >
        <Field label="Find by email">{(id) => <input id={id} type="search" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" />}</Field>
        <Button type="submit">Search</Button>
      </form>
      <ErrorNote error={users.error} />
      {users.loading && !users.data ? (
        <Skeleton rows={5} />
      ) : users.data?.page.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">email</th>
                <th scope="col">name</th>
                <th scope="col">status</th>
                <th scope="col">joined</th>
              </tr>
            </thead>
            <tbody>
              {users.data.page.map((u) => (
                <tr key={u._id} tabIndex={0} className="clickable" onClick={() => setSelected(u)} onKeyDown={(e) => e.key === "Enter" && setSelected(u)}>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>
                    {u.banned ? <Badge tone="bad">banned</Badge> : u.emailVerified ? <Badge tone="ok">verified</Badge> : <Badge>unverified</Badge>}
                  </td>
                  <td className="muted nowrap">{formatTime(u._creationTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="users">No users{query ? ` with email ${query}` : ""}.</Empty>
      )}
      <div className="toolbar">
        <Button variant="ghost" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
          ← Previous
        </Button>
        <Button variant="ghost" disabled={!users.data || users.data.isDone} onClick={() => setCursors((c) => [...c, users.data!.continueCursor])}>
          Next →
        </Button>
      </div>
      {selected && <UserDrawer user={selected} admin={admin} onClose={() => setSelected(null)} onChanged={users.reload} />}
    </section>
  );
}

function UserDrawer({ user, admin, onClose, onChanged }: { user: User; admin: Admin; onClose: () => void; onChanged: () => void }) {
  const sessions = useAsync(() => get<Session[]>("sessions", { userId: user._id }), [user._id]);
  const [banned, setBanned] = useState(Boolean(user.banned));
  const { run, busy } = useAction();
  const write = canWrite(admin);
  return (
    <Drawer title={user.email} onClose={onClose}>
      <p className="muted small">
        {user.name} · <span className="mono">{user._id}</span> · joined {formatTime(user._creationTime)}
      </p>
      {write && (
        <div className="toolbar">
          <Button
            variant={banned ? "ghost" : "danger"}
            disabled={busy}
            onClick={() =>
              (banned || confirm(`Ban ${user.email}? Their sessions end and they can't sign in.`)) &&
              run(() => post("banUser", { userId: user._id, banned: !banned }), banned ? "Unbanned" : "Banned and signed out").then((r) => {
                if (!r.ok) return;
                setBanned(!banned);
                sessions.reload();
                onChanged();
              })
            }
          >
            {banned ? "Unban" : "Ban user"}
          </Button>
        </div>
      )}
      <h3>Sessions</h3>
      <ErrorNote error={sessions.error} />
      {sessions.loading ? (
        <Skeleton rows={5} />
      ) : sessions.data?.length ? (
        <ul className="sessions">
          {sessions.data.map((s) => (
            <li key={s._id}>
              <div>
                <strong>{s.userAgent?.slice(0, 60) ?? "unknown client"}</strong>
                <div className="muted small">
                  {s.ipAddress ?? "no ip"} · started {ago(s.createdAt ?? s._creationTime)} · expires {formatTime(s.expiresAt)}
                </div>
              </div>
              {write && (
                <Button variant="ghost" disabled={busy} onClick={() => run(() => post("revokeSession", { id: s._id }), "Session revoked").then(sessions.reload)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="users">No active sessions.</Empty>
      )}
    </Drawer>
  );
}
