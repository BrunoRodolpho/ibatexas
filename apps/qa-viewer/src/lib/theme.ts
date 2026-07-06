// Theme toggle — respects the OS preference until the operator overrides it,
// then stamps data-theme on <html> (styles.css tokens redefine per theme).
// State is intentionally in-memory only (a dev tool; no persistence surface).

export type ThemeChoice = "system" | "light" | "dark"

export function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function isDark(choice: ThemeChoice): boolean {
  return choice === "system" ? systemDark() : choice === "dark"
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === "system") root.removeAttribute("data-theme")
  else root.setAttribute("data-theme", choice)
}

/** Cycle to the opposite of what is currently shown (system → its inverse). */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return isDark(choice) ? "light" : "dark"
}
