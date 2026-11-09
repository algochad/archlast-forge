// Methods Bun puts on every Buffer that @types/bun leaves out. The codec uses them because they skip the layers (and the
// encoding lookup) of `toString`/`write`: `latin1Slice` for ASCII text and header bytes, `utf8Slice`/`utf8Write` for
// strings.
interface Buffer {
  latin1Slice(start?: number, end?: number): string;
  utf8Slice(start?: number, end?: number): string;
  utf8Write(string: string, offset?: number, length?: number): number;
}
