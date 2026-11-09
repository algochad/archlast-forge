// A page the compiler does not understand (it calls a method), so React prints it.
export default function Odd() {
  const words = ["b", "a"].sort().join("-");
  return <main id="odd">{words}</main>;
}
