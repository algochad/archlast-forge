// A page that asks to be kept for anonymous visitors: the counter says how many times it was really rendered.
let renders = 0;

export const handle = { cache: { ttl: 30, tags: ["cached"] } };

export default function Cached() {
  renders++;
  return <p id="renders">rendered {renders}</p>;
}
