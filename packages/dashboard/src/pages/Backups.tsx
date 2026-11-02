import { useRef, useState } from "react";
import { adminUrl, canWrite, formatBytes, get, post, type Admin } from "../api";
import { Icon } from "../brand";
import { ago, fullTime, plural } from "../format";
import { Callout, Card } from "../kit";
import { Badge, Button, Drawer, Empty, ErrorNote, Field, Skeleton, useAction, useAsync, useToast } from "../ui";

type Manifest = {
  engine: string;
  createdAt: number;
  dialect: string;
  release?: string;
  tables: Record<string, number>;
  system: { scheduled: number; migrations: number; env: number; settings: number };
  functions: { files: number; bytes: number; hash: string };
  files: { included: boolean; count: number; bytes: number; missing: number };
};
type Backup = {
  _id: string;
  name: string;
  createdAt: number;
  kind: "manual" | "scheduled" | "pre-restore" | "uploaded" | "cli" | "found";
  state: "running" | "done" | "failed" | "found";
  bytes: number | null;
  location: string;
  manifest: Manifest | null;
  progress: string | null;
  error: string | null;
  actor: string | null;
};
type Restoring = { id: string; startedAt: number; step: string; finishedAt?: number; error?: string; done?: { documents: number; files: number; tables: number; config: boolean } };
type Listing = {
  backups: Backup[];
  target: { kind: "dir" | "s3"; location: string };
  storeError: string | null;
  schedule: { cron: string; keep: number; files: boolean; next: number | null };
  storage: boolean;
  functionsHash: string;
  restoring: Restoring | null;
};
type Setting = { name: string; source: "environment" | "dashboard" | "default"; value: string | null };

const KIND: Record<Backup["kind"], { label: string; tone: "neutral" | "ok" | "warn" | "accent" }> = {
  manual: { label: "manual", tone: "neutral" },
  scheduled: { label: "scheduled", tone: "accent" },
  "pre-restore": { label: "before a restore", tone: "warn" },
  uploaded: { label: "uploaded", tone: "neutral" },
  cli: { label: "CLI", tone: "neutral" },
  found: { label: "found in storage", tone: "warn" },
};

const documents = (m: Manifest) => Object.values(m.tables).reduce((a, b) => a + b, 0);

/** Presets for the schedule; anything else is a cron expression typed by hand. All in UTC. */
function describeCron(cron: string) {
  if (!cron) return "Off";
  const m = /^(\d+) (\d+|\*) \* \* (\*|\d)$/.exec(cron);
  if (cron === "0 * * * *") return "Every hour, on the hour";
  if (m && m[2] !== "*") {
    const at = `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")} UTC`;
    return m[3] === "*" ? `Every day at ${at}` : `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(m[3])]} at ${at}`;
  }
  return `cron ${cron} (UTC)`;
}

export function Backups({ admin }: { admin: Admin }) {
  const owner = admin.role === "owner";
  const [fast, setFast] = useState(false);
  const list = useAsync(() => get<Listing>("backups.list"), [], { interval: fast ? 1500 : 10_000 });
  const settings = useAsync(() => get<{ settings: Setting[] }>("settings"), []);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [withFiles, setWithFiles] = useState(true);
  const { run, busy } = useAction();
  const toast = useToast();
  const upload = useRef<HTMLInputElement>(null);
  const data = list.data;
  const active = Boolean(data?.backups.some((b) => b.state === "running") || (data?.restoring && !data.restoring.finishedAt));
  if (active !== fast) setFast(active);

  if (!data)
    return list.error ? (
      <ErrorNote error={list.error} />
    ) : (
      <div className="panel">
        <Skeleton rows={6} />
      </div>
    );
  const r = data.restoring;
  const running = r && !r.finishedAt;
  const restoredFrom = r && data.backups.find((b) => b._id === r.id);

  return (
    <div className="stack">
      {r &&
        (running ? (
          <Callout tone="warn" icon="refresh" title="Restoring">
            {restoredFrom?.name ?? r.id}: {r.step}… Writes wait while the documents are replaced.
          </Callout>
        ) : r.error ? (
          <Callout tone="bad" icon="errors" title="The restore failed; nothing was changed">
            {r.error}
          </Callout>
        ) : (
          r.done &&
          Date.now() - (r.finishedAt ?? 0) < 30 * 60_000 && (
            <Callout tone="ok" icon="check" title="Restored">
              {plural(r.done.documents, "document")} in {plural(r.done.tables, "table")}
              {r.done.files ? `, ${plural(r.done.files, "file")}` : ""}, {ago(r.finishedAt!)}. Live queries have re-run.
              {r.done.config && " The environment variables and settings were restored too: reload the runtime (Settings) for the variables, restart for the settings."}
            </Callout>
          )
        ))}

      <div className="grid-2">
        <Card
          title="Schedule"
          extra={
            owner && (
              <Button variant="ghost" onClick={() => setScheduleOpen(true)}>
                <Icon name="edit" size={14} /> Change
              </Button>
            )
          }
        >
          <div className="stack">
            <p style={{ margin: 0 }}>
              <strong>{describeCron(data.schedule.cron)}</strong>
              {data.schedule.cron && (
                <span className="muted">
                  {" "}
                  · keeps the last {data.schedule.keep} · {data.schedule.files ? "with files" : "without files"}
                </span>
              )}
            </p>
            {data.schedule.next !== null && (
              <p className="muted small" style={{ margin: 0 }}>
                Next: {fullTime(data.schedule.next)}
              </p>
            )}
            <p className="muted small" style={{ margin: 0 }}>
              Kept in <code>{data.target.location.replace(/^(dir|s3):/, "")}</code>
              {data.target.kind === "dir" ? " on this server" : ""}. A backup holds the documents, scheduled jobs, environment and settings, the <code>forge/</code> source
              {data.storage ? " and the files in storage" : ""}.
            </p>
            {data.storeError && <p className="note error">Can't list the backup store: {data.storeError}</p>}
          </div>
        </Card>
        <Card title="Make or bring one">
          <div className="stack">
            {canWrite(admin) ? (
              <div className="toolbar">
                <Button disabled={busy} onClick={() => run(() => post("backups.create", { files: withFiles }), "Backup started").then(() => (setFast(true), list.reload()))}>
                  <Icon name="backups" size={15} /> Back up now
                </Button>
                {data.storage && (
                  <label className="check-inline">
                    <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} /> include files
                  </label>
                )}
              </div>
            ) : (
              <p className="muted small">Admins and owners can make backups.</p>
            )}
            {owner && (
              <>
                <input
                  ref={upload}
                  type="file"
                  accept=".gz,.tgz,application/gzip"
                  hidden
                  aria-label="Backup archive to upload"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    void run(async () => {
                      toast(`Uploading ${file.name} (${formatBytes(file.size)})…`);
                      const res = await fetch(adminUrl("backups/upload"), { method: "POST", credentials: "same-origin", headers: { "x-forge-admin": "1" }, body: file });
                      const body = await res.json().catch(() => null);
                      if (!res.ok) throw new Error(body?.error?.message ?? body?.message ?? res.statusText);
                    }, "Backup uploaded").then(list.reload);
                  }}
                />
                <div className="toolbar">
                  <Button variant="ghost" disabled={busy} onClick={() => upload.current?.click()}>
                    <Icon name="upload" size={15} /> Upload a backup
                  </Button>
                  <span className="muted small">a .tar.gz from another server or an earlier download</span>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      <section className="panel" aria-label="Backups">
        {data.backups.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">made</th>
                  <th scope="col">kind</th>
                  <th scope="col">contents</th>
                  <th scope="col" className="num">
                    size
                  </th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {data.backups.map((b) => (
                  <tr key={b._id}>
                    <td className="nowrap">
                      <div>{fullTime(b.createdAt)}</div>
                      <div className="muted small">
                        {ago(b.createdAt)}
                        {b.actor && b.actor !== "schedule" ? ` · ${b.actor === "admin-key" ? "admin key" : b.actor}` : ""}
                      </div>
                    </td>
                    <td>
                      <Badge tone={KIND[b.kind].tone}>{KIND[b.kind].label}</Badge>
                    </td>
                    <td>
                      {b.state === "running" ? (
                        <span className="muted">
                          <Icon name="refresh" size={13} /> {b.progress ?? "starting"}…
                        </span>
                      ) : b.state === "failed" ? (
                        <span className="bad">Failed: {b.error}</span>
                      ) : b.manifest ? (
                        <>
                          <div>
                            {plural(documents(b.manifest), "document")} in {plural(Object.keys(b.manifest.tables).length, "table")}
                            {b.manifest.files.included ? ` · ${plural(b.manifest.files.count, "file")} (${formatBytes(b.manifest.files.bytes)})` : " · no files"}
                          </div>
                          <div className="muted small">
                            {plural(b.manifest.functions.files, "source file")} ·{" "}
                            {b.manifest.functions.hash === data.functionsHash ? "the code running now" : <span className="warn-text">different code from what runs now</span>}
                            {b.manifest.files.missing ? ` · ${plural(b.manifest.files.missing, "file was", "files were")} already gone` : ""}
                          </div>
                        </>
                      ) : (
                        <span className="muted">{b.name}</span>
                      )}
                    </td>
                    <td className="num">{formatBytes(b.bytes)}</td>
                    <td className="nowrap">
                      {owner && (b.state === "done" || b.state === "found") && (
                        <>
                          <a className="btn ghost" href={adminUrl("backups/download", { id: b._id })} download={b.name} title="Download">
                            <Icon name="download" size={14} /> Download
                          </a>
                          <Button variant="ghost" disabled={Boolean(running)} onClick={() => setRestoring(b)}>
                            Restore
                          </Button>
                        </>
                      )}
                      {owner && b.state !== "running" && (
                        <Button
                          variant="ghost"
                          className="icon-only"
                          aria-label={`Delete ${b.name}`}
                          title="Delete"
                          disabled={busy}
                          onClick={() =>
                            confirm(`Delete ${b.name}? The archive is removed from ${data.target.kind === "s3" ? "the bucket" : "disk"}.`) &&
                            run(() => post("backups.delete", { id: b._id }), "Deleted").then(list.reload)
                          }
                        >
                          <Icon name="trash" size={15} />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="backups">No backups yet. Make one now, or set a schedule.</Empty>
        )}
      </section>

      {restoring && (
        <RestoreForm
          backup={restoring}
          sameCode={restoring.manifest ? restoring.manifest.functions.hash === data.functionsHash : null}
          storage={data.storage}
          onClose={() => setRestoring(null)}
          onStarted={() => (setRestoring(null), setFast(true), list.reload())}
        />
      )}
      {scheduleOpen && (
        <ScheduleForm
          listing={data}
          settings={settings.data?.settings ?? []}
          onClose={() => setScheduleOpen(false)}
          onSaved={() => (setScheduleOpen(false), list.reload(), settings.reload())}
        />
      )}
    </div>
  );
}

function RestoreForm({ backup, sameCode, storage, onClose, onStarted }: { backup: Backup; sameCode: boolean | null; storage: boolean; onClose: () => void; onStarted: () => void }) {
  const m = backup.manifest;
  const [files, setFiles] = useState(Boolean(m?.files.included ?? true) && storage);
  const [config, setConfig] = useState(false);
  const [typed, setTyped] = useState("");
  const { run, busy } = useAction();
  return (
    <Drawer title="Restore this backup" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => post("backups.restore", { id: backup._id, files, config }), "Restore started").then((r) => r.ok && onStarted());
        }}
      >
        <p style={{ margin: 0 }}>
          <strong>{fullTime(backup.createdAt)}</strong> <span className="muted">({ago(backup.createdAt)})</span>
        </p>
        {m && (
          <p className="muted small" style={{ margin: 0 }}>
            {plural(documents(m), "document")} in {plural(Object.keys(m.tables).length, "table")}, {plural(m.system.scheduled, "scheduled job")}
            {m.files.included ? `, ${plural(m.files.count, "file")}` : ""}. Made by engine {m.engine} on {m.dialect}.
          </p>
        )}
        <Callout tone="warn" icon="errors" title="This replaces every document">
          Every table becomes what it was in the backup, in one transaction: if any document doesn't fit the schema, nothing changes. Documents written since are gone. Writes wait while it
          runs. A backup of what is there now is made first, so you can go back.
        </Callout>
        {sameCode === false && (
          <Callout tone="bad" icon="functions" title="Made with different code">
            The backup's <code>forge/</code> source isn't what runs now. If the schema changed, documents may not fit it; its source is in the archive (download it) if you need to deploy it
            first.
          </Callout>
        )}
        <label className="check-inline">
          <input type="checkbox" checked={files} disabled={!storage || !m?.files.included} onChange={(e) => setFiles(e.target.checked)} /> Restore the files
          {!storage ? " (storage is off here)" : m && !m.files.included ? " (this backup has none)" : ""}
        </label>
        <p className="muted small" style={{ margin: "-0.4rem 0 0 1.6rem" }}>
          Files the backup has are written back under their names. Files uploaded since stay in storage.
        </p>
        <label className="check-inline">
          <input type="checkbox" checked={config} onChange={(e) => setConfig(e.target.checked)} /> Also replace environment variables and settings
        </label>
        <p className="muted small" style={{ margin: "-0.4rem 0 0 1.6rem" }}>
          Leave this off when restoring into another deployment: the backup's API keys and settings would replace this one's.
        </p>
        <Field label='Type "restore" to confirm'>{(id) => <input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
        <Button type="submit" variant="danger" disabled={busy || typed.trim().toLowerCase() !== "restore"}>
          <Icon name="refresh" size={15} /> Restore
        </Button>
      </form>
    </Drawer>
  );
}

type Preset = "off" | "hourly" | "daily" | "weekly" | "custom";

function presetOf(cron: string): { preset: Preset; time: string; day: string } {
  if (!cron) return { preset: "off", time: "03:00", day: "0" };
  if (cron === "0 * * * *") return { preset: "hourly", time: "03:00", day: "0" };
  const m = /^(\d+) (\d+) \* \* (\*|\d)$/.exec(cron);
  if (m) return { preset: m[3] === "*" ? "daily" : "weekly", time: `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`, day: m[3] === "*" ? "0" : m[3]! };
  return { preset: "custom", time: "03:00", day: "0" };
}

function ScheduleForm({ listing, settings, onClose, onSaved }: { listing: Listing; settings: Setting[]; onClose: () => void; onSaved: () => void }) {
  const initial = presetOf(listing.schedule.cron);
  const [preset, setPreset] = useState<Preset>(initial.preset);
  const [time, setTime] = useState(initial.time);
  const [day, setDay] = useState(initial.day);
  const [custom, setCustom] = useState(listing.schedule.cron);
  const [keep, setKeep] = useState(String(listing.schedule.keep));
  const [files, setFiles] = useState(listing.schedule.files);
  const { run, busy } = useAction();
  const fixed = settings.filter((s) => s.name.startsWith("BACKUP_") && s.source === "environment").map((s) => s.name);
  const [h, mm] = time.split(":").map(Number);
  const cron =
    preset === "off" ? "" : preset === "hourly" ? "0 * * * *" : preset === "daily" ? `${mm ?? 0} ${h ?? 3} * * *` : preset === "weekly" ? `${mm ?? 0} ${h ?? 3} * * ${day}` : custom.trim();
  return (
    <Drawer title="Backup schedule" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const save = (name: string, value: string | null) => (fixed.includes(name) ? Promise.resolve() : post("saveSetting", { name, value }));
            await save("BACKUP_SCHEDULE", cron || null);
            await save("BACKUP_KEEP", keep);
            await save("BACKUP_FILES", files ? "on" : "off");
          }, "Schedule saved").then((r) => r.ok && onSaved());
        }}
      >
        {fixed.length > 0 && (
          <Callout tone="warn" icon="key" title="Set in the environment">
            {fixed.join(", ")} {fixed.length === 1 ? "is" : "are"} set where the engine is deployed, which wins over this page.
          </Callout>
        )}
        <Field label="When (UTC)">
          {(id) => (
            <select id={id} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              <option value="off">Off</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="custom">Cron expression</option>
            </select>
          )}
        </Field>
        {(preset === "daily" || preset === "weekly") && (
          <div className="grid-form">
            {preset === "weekly" && (
              <Field label="Day">
                {(id) => (
                  <select id={id} value={day} onChange={(e) => setDay(e.target.value)}>
                    {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
                      <option key={d} value={String(i)}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <Field label="At (UTC)">{(id) => <input id={id} type="time" value={time} onChange={(e) => setTime(e.target.value)} required />}</Field>
          </div>
        )}
        {preset === "custom" && (
          <Field label="Cron expression" hint="minute hour day month weekday, in UTC">
            {(id) => <input id={id} className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0 3 * * *" required />}
          </Field>
        )}
        <div className="grid-form">
          <Field label="Keep the last">{(id) => <input id={id} type="number" min={1} value={keep} onChange={(e) => setKeep(e.target.value)} required />}</Field>
        </div>
        <label className="check-inline">
          <input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} /> Include the files in storage
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          Applies at once, on every server. Where backups go is under Settings → Backups (BACKUP_DIR, or a bucket of their own with BACKUP_S3_*).
        </p>
        <Button type="submit" disabled={busy}>
          <Icon name="check" size={15} /> Save schedule
        </Button>
      </form>
    </Drawer>
  );
}
