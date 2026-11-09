# Third-party notices

## Traceway

`src/server/telemetry/traceway.ts` is ported from [Traceway](https://github.com/tracewayapp/traceway) (Go to TypeScript):

- the exception fingerprint, from `backend/app/controllers/clientcontrollers/client.controller.go` (`ComputeExceptionHash`): the stack
  normalization and SHA-256 hash that group occurrences of one error into an issue;
- the endpoint impact score and its reason, from `backend/app/repositories/telemetry/shared/impact.go` (`ComputeImpactScore`,
  `ComputeImpactReason`): the inverted Apdex and the error-rate, p99, client-error and volume floors.

Changes from the original are described where they are made in that file.

```
MIT License

Copyright (c) 2026 dusanstanojeviccs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## tRPC

`src/forge-rpc/` (Forge RPC's server and client) speaks the HTTP batch protocol of [tRPC](https://github.com/trpc/trpc) v11 and is written from it:

- the wire format: a batch as `POST /a.b,c.d?batch=1` with `{"0": input, …}`, answered by an array of `{"result":{"data"}}` or `{"error":{"message","code","data"}}`, and the rule for the status of a batch (the common status, or 207), from `packages/tuyerer/src/unstable-core-do-not-import/http/resolveResponse.ts`;
- the table of error codes with their JSON-RPC numbers and HTTP statuses, from `rpc/codes.ts` and `http/getHTTPStatusCode.ts` in the same package;
- the message of a Zod input error (Zod's own JSON text of the issues), as tRPC sends it.

No tRPC code runs: `@trpc/client` and `@trpc/server` are development dependencies, used only by `test/forge-rpc.test.ts` to check that this implementation and the library understand each other.

```
MIT License

Copyright (c) 2023 Alex Johansson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## coraza-node, Coraza and the OWASP Core Rule Set

`src/server/waf/` is derived from [coraza-node](https://github.com/coraza-incubator/coraza-node) (`@coraza/core`'s `abi.ts`, `transaction.ts`, `wasm.ts`, `waf.ts` and `wasi.ts`, and `@coraza/coreruleset`'s `recommended()`), at version 0.1.0-preview.3:

- the bindings to the WebAssembly module's exports and the request bundle's layout (`abi.ts`, `transaction.ts`);
- the instantiation of the module and the WASI imports it uses (`wasm.ts`, `wasi.ts`; changed so that it runs on Bun, where `node:wasi` ends the process when Go's `main` returns);
- the list of Core Rule Set files and the setup directives (`rules.ts`).

The WebAssembly module itself (`dist/wasm/coraza.wasm`, which holds [OWASP Coraza](https://github.com/corazawaf/coraza) and the [OWASP Core Rule Set](https://github.com/coreruleset/coreruleset), also Apache-2.0) comes from the `@coraza/core` package, which the runtime depends on, and is not copied into this repository. Changes from the original are described where they are made in each file.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

   Copyright 2026 Juan Pablo Tosso.
```
