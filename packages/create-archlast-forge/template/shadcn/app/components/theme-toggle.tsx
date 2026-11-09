import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Switches between light and dark by toggling `dark` on <html>, and remembers the choice. Until then the page follows the system. The click is handled by the
 * script in app/root.tsx (it looks for `data-theme-toggle`), so this needs no JavaScript of its own: it is part of the page, not an island.
 */
export function ThemeToggle() {
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle dark mode" data-theme-toggle>
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
    </Button>
  );
}
