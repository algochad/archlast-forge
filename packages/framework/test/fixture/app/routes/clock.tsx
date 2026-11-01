import { useNow } from "@archlast/forge-framework";

export default function Clock() {
  const seconds = useNow(1000);
  const minutes = useNow();
  return (
    <main id="clock">
      <title>Clock</title>
      <p id="seconds">{seconds}</p>
      <p id="minutes">{minutes}</p>
    </main>
  );
}
