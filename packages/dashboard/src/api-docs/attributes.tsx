// Attribute lists: a parameter, a header, a body or a response as rows of name, type, flags and the details a validator carries (allowed
// values, limits, default, example), with nested objects opened under their row.
import type { ReactNode } from "react";
import { useT } from "./context";
import { Markdown } from "./markdown";
import { deref, type HeaderObject, type OpenApi, type Schema } from "./openapi";
import { describe, show, type ConstraintKey, type Info } from "./schema";
import type { StringKey } from "./strings";

const CONSTRAINT_LABELS: Record<ConstraintKey, StringKey> = {
  format: "cFormat",
  minimum: "cMinimum",
  maximum: "cMaximum",
  exclusiveMinimum: "cExclusiveMinimum",
  exclusiveMaximum: "cExclusiveMaximum",
  multipleOf: "cMultipleOf",
  minLength: "cMinLength",
  maxLength: "cMaxLength",
  pattern: "cPattern",
  minItems: "cMinItems",
  maxItems: "cMaxItems",
  uniqueItems: "cUniqueItems",
  minProperties: "cMinProperties",
  maxProperties: "cMaxProperties",
};

export interface AttributeProps {
  doc: OpenApi;
  name: string;
  schema: Schema | undefined;
  required?: boolean;
  /** Replaces the schema's own description (a parameter's note). */
  description?: string;
  example?: unknown;
  deprecated?: boolean;
  /** The components already open above this row. */
  seen?: string[];
  depth?: number;
  /** Shown before the type: where a parameter goes. */
  where?: string;
}

function Details({ info, example, description }: { info: Info; example?: unknown; description?: string }) {
  const t = useT();
  const withNotes = info.enumValues?.some((e) => e.description);
  const eg = example !== undefined ? example : info.example;
  const hasEg = example !== undefined || info.hasExample;
  return (
    <>
      <Markdown text={description ?? info.description} />
      {info.enumValues && (
        <div className="fd-enum">
          <span className="fd-chip-label">{t("allowedValues")}</span>
          {withNotes ? (
            <ul>
              {info.enumValues.map((e, i) => (
                <li key={i}>
                  <code>{show(e.value)}</code>
                  {e.description && <span>{e.description}</span>}
                </li>
              ))}
            </ul>
          ) : (
            info.enumValues.map((e, i) => <code className="fd-chip" key={i}>{show(e.value)}</code>)
          )}
        </div>
      )}
      {(info.constraints.length > 0 || info.hasDefault || hasEg) && (
        <div className="fd-chips">
          {info.constraints.map(([k, v]) => (
            <span className="fd-chip" key={k}>
              <span className="fd-chip-label">{t(CONSTRAINT_LABELS[k])}</span> <code>{k === "uniqueItems" ? t("yes") : v}</code>
            </span>
          ))}
          {info.hasDefault && (
            <span className="fd-chip">
              <span className="fd-chip-label">{t("default")}</span> <code>{show(info.default)}</code>
            </span>
          )}
          {hasEg && (
            <span className="fd-chip">
              <span className="fd-chip-label">{t("example")}</span> <code>{show(eg)}</code>
            </span>
          )}
        </div>
      )}
    </>
  );
}

export function Attribute({ doc, name, schema, required, description, example, deprecated, seen = [], depth = 0, where }: AttributeProps) {
  const t = useT();
  const info = describe(doc, schema, seen);
  const recursive = !!info.name && seen.includes(info.name);
  const children = !recursive && depth < 6 ? info.children : undefined;
  const count = children ? (children.kind === "props" ? children.props.length : children.variants.length) : 0;
  return (
    <li className="fd-attr">
      <div className="fd-attr-head">
        <code className="fd-attr-name">{name}</code>
        {where && <span className="fd-where">{where}</span>}
        <span className="fd-type">{info.type}</span>
        {required && <span className="fd-flag fd-flag-req">{t("required")}</span>}
        {info.nullable && <span className="fd-flag">{t("nullable")}</span>}
        {(deprecated || info.deprecated) && <span className="fd-flag fd-flag-warn">{t("deprecated")}</span>}
        {info.readOnly && <span className="fd-flag">{t("readOnly")}</span>}
        {info.writeOnly && <span className="fd-flag">{t("writeOnly")}</span>}
      </div>
      <div className="fd-attr-body">
        <Details info={info} example={example} description={description} />
        {recursive && <p className="fd-note">{t("recursive", { name: info.name! })}</p>}
        {children && (
          <details className="fd-nested">
            <summary>{children.kind === "props" ? t("childAttributes", { n: count }) : t("variants", { n: count })}</summary>
            {children.kind === "props" ? (
              <Properties doc={doc} props={children.props} required={children.required} seen={info.seen} depth={depth + 1} />
            ) : (
              children.variants.map((variant, i) => {
                const vi = describe(doc, variant, info.seen);
                return (
                  <div className="fd-variant" key={i}>
                    <div className="fd-variant-title">
                      <span className="fd-type">{vi.type}</span>
                      {vi.schema.title && <strong>{vi.schema.title}</strong>}
                    </div>
                    <Markdown text={vi.description} />
                    {vi.children?.kind === "props" && <Properties doc={doc} props={vi.children.props} required={vi.children.required} seen={vi.seen} depth={depth + 1} />}
                  </div>
                );
              })
            )}
          </details>
        )}
      </div>
    </li>
  );
}

export function Properties({ doc, props, required, seen, depth = 0 }: { doc: OpenApi; props: [string, Schema][]; required: Set<string>; seen?: string[]; depth?: number }): ReactNode {
  return (
    <ul className="fd-attrs">
      {props.map(([name, schema]) => (
        <Attribute key={name} doc={doc} name={name} schema={schema} required={required.has(name)} seen={seen} depth={depth} />
      ))}
    </ul>
  );
}

/** The fields of a body or a response: an object's properties, an array's items' properties, or a single row for anything else. */
export function Body({ doc, schema }: { doc: OpenApi; schema: Schema | undefined }) {
  const t = useT();
  const info = describe(doc, schema);
  if (info.children?.kind === "props") return <Properties doc={doc} props={info.children.props} required={info.children.required} seen={info.seen} />;
  if (info.children?.kind === "variants")
    return (
      <ul className="fd-attrs">
        <Attribute doc={doc} name={t("body")} schema={schema} />
      </ul>
    );
  return (
    <ul className="fd-attrs">
      <Attribute doc={doc} name={t("value")} schema={schema} />
    </ul>
  );
}

export function HeaderRows({ doc, headers }: { doc: OpenApi; headers: Record<string, HeaderObject> }) {
  return (
    <ul className="fd-attrs">
      {Object.entries(headers).map(([name, raw]) => {
        const h = deref(doc, raw) ?? raw;
        return <Attribute key={name} doc={doc} name={name} schema={h.schema} required={h.required} description={h.description} example={h.example} deprecated={h.deprecated} />;
      })}
    </ul>
  );
}
