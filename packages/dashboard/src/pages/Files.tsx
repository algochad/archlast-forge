import { useState } from "react";
import { canWrite, formatBytes, formatTime, get, post, type Admin, type Manifest, type Page } from "../api";
import { Button, Empty, ErrorNote, Skeleton, useAction, useAsync } from "../ui";

type File = { _id: string; _creationTime: number; key: string; contentType?: string; size: number | null; url: string | null };

export function Files({ manifest, admin }: { manifest: Manifest; admin: Admin }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const files = useAsync(() => get<Page<File>>("files", { cursor: cursors.at(-1), numItems: 50 }), [cursors.at(-1)], { enabled: manifest.storage });
  const { run, busy } = useAction();
  if (!manifest.storage) return <Empty icon="files">Storage isn't configured. Set S3_ENDPOINT and S3_BUCKET (RustFS works).</Empty>;
  return (
    <section className="panel stack" aria-label="Files">
      <ErrorNote error={files.error} />
      {files.loading && !files.data ? (
        <Skeleton rows={5} />
      ) : files.data?.page.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">file</th>
                <th scope="col">type</th>
                <th scope="col" className="num">size</th>
                <th scope="col">uploaded</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {files.data.page.map((f) => (
                <tr key={f._id}>
                  <td className="mono small">{f._id}</td>
                  <td>{f.contentType ?? <span className="muted">unknown</span>}</td>
                  <td className="num">{formatBytes(f.size)}</td>
                  <td className="muted nowrap">{formatTime(f._creationTime)}</td>
                  <td className="nowrap">
                    {f.url && (
                      <a className="btn ghost" href={f.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    )}
                    {canWrite(admin) && (
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => confirm(`Delete ${f._id}? Documents referencing it keep a dangling id.`) && run(() => post("deleteFile", { id: f._id }), "Deleted").then(files.reload)}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="files">No files uploaded yet.</Empty>
      )}
      <div className="toolbar">
        <Button variant="ghost" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
          ← Previous
        </Button>
        <Button variant="ghost" disabled={!files.data || files.data.isDone} onClick={() => setCursors((c) => [...c, files.data!.continueCursor])}>
          Next →
        </Button>
      </div>
    </section>
  );
}
