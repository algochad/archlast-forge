export default function BrokenRender(): never {
  throw new Error("render bug: secret detail");
}
