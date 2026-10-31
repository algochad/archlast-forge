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
