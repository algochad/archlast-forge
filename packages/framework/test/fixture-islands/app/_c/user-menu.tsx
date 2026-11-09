import { useNavigate, useViewer } from "@archlast/forge-framework";
import { useState } from "react";

/** An island with state, a handler and a way to navigate. */
export function UserMenu({ label }: { label: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <span id="menu">
      <button id="menu-button" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <span id="menu-open">
          {viewer ? viewer.name : "nobody"} <button id="go-about" onClick={() => navigate("/about")}>about</button>
        </span>
      )}
    </span>
  );
}
