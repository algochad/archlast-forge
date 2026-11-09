import { useState } from "react";

export function Menu({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button id="menu" type="button" onClick={() => setOpen(!open)}>
      {open ? "Close" : name}
    </button>
  );
}
