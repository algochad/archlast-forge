import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Switches between light and dark by toggling `dark` on <html>, and remembers the choice. Until then the page follows the system (see the script in root.tsx). */
export function ThemeToggle() {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle dark mode"
      onClick={() => {
        const dark = document.documentElement.classList.toggle("dark");
        try {
          localStorage.setItem("theme", dark ? "dark" : "light");
        } catch {}
      }}
    >
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
    </Button>
  );
}
