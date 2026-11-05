// The browser side of the embed test: hydrates what the server rendered, the way a full-stack app's page would.
import { hydrateRoot } from "react-dom/client";
import "../../src/api-docs/styles.css";
import { ApiReference } from "../../src/api-docs/react";
import doc from "./openapi.json";

const w = window as unknown as { __errors: string[] };
w.__errors = [];
hydrateRoot(document.getElementById("root")!, <ApiReference document={doc as never} explorerUrl={null} />, { onRecoverableError: (e) => w.__errors.push(String(e)) });
