// Wears the colour theme chosen in the desktop app. The desktop serves it at
// GET /theme (six colours); everything else in theme.css is derived from them
// here, the same way the desktop derives its tints, so the two always match.
// The last theme is kept in localStorage so the popup is right instantly and
// stays right when the desktop is not running.
import { API_BASE } from "./constants.js";

const CACHE_KEY = "carmenTheme";

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => {
  const [x, y] = [channels(a), channels(b)];
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
};

export function themeVariables(colours) {
  const { ink, muted, accent, page } = colours;
  return {
    "--ink": ink,
    "--ink-2": mix(ink, muted, 0.5),
    "--ink-3": muted,
    "--accent": accent,
    "--accent-strong": mix(accent, "#000000", 0.2),
    "--accent-soft": mix(accent, "#ffffff", 0.88),
    "--paper": mix(page, "#000000", 0.035),
    "--surface-2": page,
    "--line": mix(page, "#000000", 0.1),
    "--line-strong": mix(page, "#000000", 0.2),
  };
}

function paint(colours) {
  // The dark skin (system dark mode, or a running session) keeps its own palette.
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return;
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(themeVariables(colours))) style.setProperty(name, value);
}

export async function applyDesktopTheme() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached) paint(cached);
  } catch (err) {
    // no cache yet: the stylesheet's own colours are fine
  }
  try {
    const response = await fetch(`${API_BASE}/theme`);
    if (!response.ok) return;
    const { colours } = await response.json();
    paint(colours);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(colours));
    } catch (err) {
      // storage blocked: painting still worked
    }
  } catch (err) {
    // desktop not running: keep the cached or default colours
  }
}
