(() => {
  const KEY = "zebra-theme", root = document.documentElement, modes = ["system", "light", "dark"];
  const read = () => { try { const v = localStorage.getItem(KEY); return modes.includes(v) ? v : "system"; } catch { return "system"; } };
  const apply = m => m === "system" ? root.removeAttribute("data-theme") : root.setAttribute("data-theme", m);
  let mode = read();
  apply(mode);
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const icons = {
    system: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>')
  };
  const label = { system: "Theme: follow system", light: "Theme: light", dark: "Theme: dark" };
  const paint = () => document.querySelectorAll("[data-theme-toggle]").forEach(b => { b.innerHTML = icons[mode]; b.title = b.ariaLabel = label[mode] + " (click to change)"; });
  addEventListener("DOMContentLoaded", () => {
    paint();
    document.querySelectorAll("[data-theme-toggle]").forEach(b => b.addEventListener("click", () => {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      try { mode === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, mode); } catch { }
      apply(mode); paint();
    }));
  });
})();
