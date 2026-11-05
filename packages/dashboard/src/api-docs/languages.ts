// The code samples other than cURL, made from the same request. Loaded when someone picks one of them.
import type { CodeSampleLanguage } from "./contract";
import { curl, type SampleRequest } from "./samples";

const q = (s: string) => JSON.stringify(s);
const pad = (text: string, by: string) => text.split("\n").map((l, i) => (i ? by + l : l)).join("\n");

function node(r: SampleRequest): string {
  const headers = r.headers.map(([k, v]) => `    ${q(k)}: ${q(v)},`).join("\n");
  const body = r.body?.kind === "json" ? `JSON.stringify(${pad(JSON.stringify(r.body.value, null, 2), "  ")})` : r.body ? q(r.body.text) : "";
  return [
    `const response = await fetch(${q(r.url)}, {`,
    `  method: ${q(r.method)},`,
    ...(headers ? [`  headers: {`, headers, `  },`] : []),
    ...(body ? [`  body: ${body},`] : []),
    `});`,
    `const data = await response.json();`,
  ].join("\n");
}

/** A JSON value as a Python literal. */
function py(v: unknown, indent = 0): string {
  const pad = "    ".repeat(indent + 1);
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${pad}${py(x, indent + 1)},`).join("\n")}\n${"    ".repeat(indent)}]` : "[]";
  const e = Object.entries(v);
  return e.length ? `{\n${e.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${py(x, indent + 1)},`).join("\n")}\n${"    ".repeat(indent)}}` : "{}";
}

function python(r: SampleRequest): string {
  const headers = r.headers.map(([k, v]) => `        ${q(k)}: ${q(v)},`).join("\n");
  return [
    `import requests`,
    ``,
    `response = requests.request(`,
    `    ${q(r.method)},`,
    `    ${q(r.url)},`,
    ...(headers ? [`    headers={`, headers, `    },`] : []),
    ...(r.body?.kind === "json" ? [`    json=${py(r.body.value, 1)},`] : r.body?.kind === "form" ? [`    data=${py(Object.fromEntries(r.body.fields), 1)},`] : r.body ? [`    data=${q(r.body.text)},`] : []),
    `)`,
    `data = response.json()`,
  ].join("\n");
}

function go(r: SampleRequest): string {
  const body = r.body ? (r.body.kind === "json" ? JSON.stringify(r.body.value) : r.body.text) : "";
  return [
    `package main`,
    ``,
    `import (`,
    `\t"fmt"`,
    `\t"io"`,
    `\t"net/http"`,
    ...(body ? [`\t"strings"`] : []),
    `)`,
    ``,
    `func main() {`,
    `\treq, _ := http.NewRequest(${q(r.method)}, ${q(r.url)}, ${body ? `strings.NewReader(\`${body.replace(/`/g, "` + \"`\" + `")}\`)` : "nil"})`,
    ...r.headers.map(([k, v]) => `\treq.Header.Set(${q(k)}, ${q(v)})`),
    `\tres, err := http.DefaultClient.Do(req)`,
    `\tif err != nil {`,
    `\t\tpanic(err)`,
    `\t}`,
    `\tdefer res.Body.Close()`,
    `\tdata, _ := io.ReadAll(res.Body)`,
    `\tfmt.Println(string(data))`,
    `}`,
  ].join("\n");
}

const sq = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function php(r: SampleRequest): string {
  const body = r.body ? (r.body.kind === "json" ? JSON.stringify(r.body.value) : r.body.text) : "";
  return [
    `<?php`,
    `$ch = curl_init(${sq(r.url)});`,
    `curl_setopt_array($ch, [`,
    `    CURLOPT_CUSTOMREQUEST => ${sq(r.method)},`,
    `    CURLOPT_RETURNTRANSFER => true,`,
    ...(r.headers.length ? [`    CURLOPT_HTTPHEADER => [`, ...r.headers.map(([k, v]) => `        ${sq(`${k}: ${v}`)},`), `    ],`] : []),
    ...(body ? [`    CURLOPT_POSTFIELDS => ${sq(body)},`] : []),
    `]);`,
    `$response = curl_exec($ch);`,
    `curl_close($ch);`,
    `$data = json_decode($response, true);`,
  ].join("\n");
}

function ruby(r: SampleRequest): string {
  const body = r.body ? (r.body.kind === "json" ? JSON.stringify(r.body.value) : r.body.text) : "";
  const klass = r.method[0] + r.method.slice(1).toLowerCase();
  return [
    `require "net/http"`,
    `require "json"`,
    ``,
    `uri = URI(${q(r.url)})`,
    `request = Net::HTTP::${klass}.new(uri)`,
    ...r.headers.map(([k, v]) => `request[${q(k)}] = ${q(v)}`),
    ...(body ? [`request.body = ${sq(body)}`] : []),
    `response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") { |http| http.request(request) }`,
    `data = JSON.parse(response.body)`,
  ].join("\n");
}

function java(r: SampleRequest): string {
  const body = r.body ? (r.body.kind === "json" ? JSON.stringify(r.body.value) : r.body.text) : "";
  return [
    `import java.net.URI;`,
    `import java.net.http.HttpClient;`,
    `import java.net.http.HttpRequest;`,
    `import java.net.http.HttpResponse;`,
    ``,
    `HttpRequest request = HttpRequest.newBuilder(URI.create(${q(r.url)}))`,
    ...r.headers.map(([k, v]) => `    .header(${q(k)}, ${q(v)})`),
    `    .method(${q(r.method)}, ${body ? `HttpRequest.BodyPublishers.ofString(${q(body)})` : "HttpRequest.BodyPublishers.noBody()"})`,
    `    .build();`,
    `HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());`,
  ].join("\n");
}

function csharp(r: SampleRequest): string {
  const body = r.body ? (r.body.kind === "json" ? JSON.stringify(r.body.value) : r.body.text) : "";
  const type = r.headers.find(([k]) => k === "Content-Type")?.[1] ?? "application/json";
  return [
    `using var client = new HttpClient();`,
    `using var request = new HttpRequestMessage(new HttpMethod(${q(r.method)}), ${q(r.url)});`,
    ...r.headers.filter(([k]) => k !== "Content-Type").map(([k, v]) => `request.Headers.TryAddWithoutValidation(${q(k)}, ${q(v)});`),
    ...(body ? [`request.Content = new StringContent(@"${body.replace(/"/g, '""')}", System.Text.Encoding.UTF8, ${q(type)});`] : []),
    `using var response = await client.SendAsync(request);`,
    `var data = await response.Content.ReadAsStringAsync();`,
  ].join("\n");
}

const GENERATORS: Record<CodeSampleLanguage, (r: SampleRequest) => string> = { curl, node, python, go, php, ruby, java, csharp };

export const generate = (lang: CodeSampleLanguage, r: SampleRequest) => GENERATORS[lang](r);
