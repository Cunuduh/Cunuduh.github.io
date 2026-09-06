(() => {
  const storageKey = "portfolio-simple-view";
  let enabled = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) enabled = saved === "true";
  } catch {}
  document.documentElement.classList.toggle("simple-view", enabled);

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector(".simple-view-toggle");
    button.setAttribute("aria-pressed", String(enabled));
    button.addEventListener("click", () => {
      enabled = !enabled;
      document.documentElement.classList.toggle("simple-view", enabled);
      button.setAttribute("aria-pressed", String(enabled));
      try { localStorage.setItem(storageKey, String(enabled)); } catch {}
      document.dispatchEvent(new Event("simpleviewchange"));
    });
  });
})();
