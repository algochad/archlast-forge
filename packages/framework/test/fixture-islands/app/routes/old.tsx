// A route the build cannot place in the island model (an action): rendered and hydrated as a whole.
export const action = async () => null;

export default function Old() {
  return <h1 id="title">Old</h1>;
}
