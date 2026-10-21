(() => {
  const burger = document.querySelector(".burger");
  const overlay = document.querySelector(".mobile-overlay");
  const sheet = document.querySelector(".mobile-menu-sheet");
  const mobileLinks = document.querySelectorAll(".mobile-link, .mobile-sign-in");

  const setMenu = (open) => {
    if (!burger || !overlay) return;

    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    overlay.hidden = !open;
    document.body.classList.toggle("menu-open", open);
  };

  burger?.addEventListener("click", () => {
    setMenu(burger.getAttribute("aria-expanded") !== "true");
  });

  overlay?.addEventListener("click", (event) => {
    if (event.target === overlay) setMenu(false);
  });

  sheet?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  mobileLinks.forEach((link) => {
    link.addEventListener("click", () => setMenu(false));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && burger?.getAttribute("aria-expanded") === "true") {
      setMenu(false);
      burger.focus();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 720 && burger?.getAttribute("aria-expanded") === "true") {
      setMenu(false);
    }
  });

  const values = Array.from(document.querySelectorAll(".stat-value"));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const formatValue = (el, value) => {
    const decimals = Number(el.dataset.decimals || 0);
    const suffix = el.dataset.suffix || "";
    return `${Number(value).toFixed(decimals)}${suffix}`;
  };

  const setFinalValues = () => {
    values.forEach((el) => {
      el.textContent = formatValue(el, Number(el.dataset.target || 0));
    });
  };

  if (reducedMotion.matches) {
    setFinalValues();
    return;
  }

  let hasCounted = false;

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const runCount = () => {
    if (hasCounted) return;
    hasCounted = true;

    values.forEach((el, i) => {
      const target = Number(el.dataset.target || 0);
      const duration = 1500 + i * 80;
      const offset = 480 + i * 90;

      window.setTimeout(() => {
        const start = performance.now();

        const frame = (now) => {
          const progress = Math.min((now - start) / duration, 1);
          const eased = easeOutCubic(progress);
          el.textContent = formatValue(el, target * eased);

          if (progress < 1) {
            requestAnimationFrame(frame);
          } else {
            el.textContent = formatValue(el, target);
          }
        };

        requestAnimationFrame(frame);
      }, offset);
    });
  };

  if ("IntersectionObserver" in window) {
    const stats = document.querySelector(".stats");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.25)) {
          runCount();
          observer.disconnect();
        }
      },
      { threshold: [0.25] }
    );

    if (stats) observer.observe(stats);
  } else {
    runCount();
  }
})();
