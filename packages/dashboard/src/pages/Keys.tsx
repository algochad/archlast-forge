import { useState } from "react";
import { canWrite, post, type Admin } from "../api";
import { Icon } from "../brand";
import { ago, fullTime } from "../format";
import { Card, Refreshing } from "../kit";
import { useObs } from "../obs";
import { Button, Empty, ErrorNote, Field, Segmented, Skeleton, useAction, useToast } from "../ui";

type Key = { id: string; name: string; prefix: string; service: string | null; created_at: number; created_by: string; last_used: number | null };

export function Keys({ admin }: { admin: Admin }) {
  const keys = useObs<Key[]>("keys", {}, { range: false });
  const [created, setCreated] = useState<{ key: string; name: string; service: string } | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const write = canWrite(admin);
  if (keys.loading && !keys.data) return <Skeleton rows={5} />;
  return (
    <div className="obs-page">
      <ErrorNote error={keys.error} />
      {write && (
        <Card title="New key">
          <form
            className="toolbar-row"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              const name = String(f.get("name"));
              const service = String(f.get("service") ?? "");
              void run(() => post<{ key: string }>("obs.createKey", { name, service: service || undefined }), "Key created: copy it now, it isn't shown again").then((r) => {
                if (!r.ok) return;
                setCreated({ key: r.value!.key, name, service });
                form.reset();
                keys.reload();
              });
            }}
          >
            <Field label="Name">{(id) => <input id={id} name="name" placeholder="billing-api production" required />}</Field>
            <Field label="Service (optional)">{(id) => <input id={id} name="service" placeholder="as named by the exporter" />}</Field>
            <Button type="submit" disabled={busy} style={{ alignSelf: "flex-end" }}>
              <Icon name="plus" size={15} /> Create key
            </Button>
          </form>
          {created && (
            <div className="new-key">
              <code>{created.key}</code>
              <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(created.key).then(() => toast("Copied"))}>
                <Icon name="copy" size={14} /> Copy
              </Button>
            </div>
          )}
        </Card>
      )}
      <Setup keyValue={created?.key} service={created?.service || created?.name} />
      <Card className="flush" title={<>Keys <span className="badge">{keys.data?.length ?? 0}</span> <Refreshing on={keys.refreshing} /></>}>
        {keys.data?.length ? (
          <table className="obs-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Key</th>
                <th scope="col">Service</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                {write && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong>
                  </td>
                  <td className="mono">{k.prefix}…</td>
                  <td>{k.service ?? <span className="faint">as reported</span>}</td>
                  <td className="small" title={fullTime(Number(k.created_at))}>
                    {ago(Number(k.created_at))} <span className="faint">by {k.created_by}</span>
                  </td>
                  <td className="small">{k.last_used ? ago(Number(k.last_used)) : <span className="faint">never</span>}</td>
                  {write && (
                    <td className="num">
                      <Button variant="danger" disabled={busy} onClick={() => confirm(`Revoke "${k.name}"? Services sending with it are refused from now on.`) && run(() => post("obs.revokeKey", { id: k.id }), "Key revoked").then(keys.reload)}>
                        Revoke
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon="key">No ingest keys. In development, local services can send without one; in production every export needs a key.</Empty>
        )}
      </Card>
    </div>
  );
}

function Setup({ keyValue, service }: { keyValue?: string; service?: string }) {
  const [lang, setLang] = useState<"env" | "nest" | "node">("env");
  const origin = location.origin;
  const key = keyValue ?? "<your key>";
  const name = service || "my-service";
  const snippets = {
    env: `OTEL_EXPORTER_OTLP_ENDPOINT=${origin}/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key}
OTEL_SERVICE_NAME=${name}
OTEL_RESOURCE_ATTRIBUTES=service.version=$GIT_COMMIT`,
    nest: `// instrumentation.ts, imported before anything else in main.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";

const headers = { Authorization: "Bearer ${key}" };
new NodeSDK({
  serviceName: "${name}",
  traceExporter: new OTLPTraceExporter({ url: "${origin}/otlp/v1/traces", headers }),
  logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: "${origin}/otlp/v1/logs", headers }))],
  instrumentations: [getNodeAutoInstrumentations()],
}).start();`,
    node: `# Any OpenTelemetry SDK, with no code: Node.js shown
npm install @opentelemetry/auto-instrumentations-node
OTEL_EXPORTER_OTLP_ENDPOINT=${origin}/otlp \\
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${key} \\
OTEL_SERVICE_NAME=${name} \\
node --require @opentelemetry/auto-instrumentations-node/register app.js`,
  };
  return (
    <Card title="Send telemetry from another service" extra={<Segmented label="Setup" value={lang} onChange={setLang} options={[{ value: "env", label: "Environment" }, { value: "nest", label: "NestJS" }, { value: "node", label: "Zero-code" }]} />}>
      <p className="muted small" style={{ margin: 0 }}>
        Point an OpenTelemetry exporter at this engine (OTLP over HTTP, protobuf or JSON). Its requests, errors, spans, logs and metrics show up next to the engine's own, on every page, and the service picker at the top switches between them.
      </p>
      <pre className="json">{snippets[lang]}</pre>
    </Card>
  );
}
