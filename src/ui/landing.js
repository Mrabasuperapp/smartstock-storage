(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hero = $(".hero"), story = $("#story"), rail = $(".rail"), stage = $("#stage");
  let ticking = false;
  const frame = () => {
    ticking = false;
    const h = document.documentElement;
    h.style.setProperty("--page", (scrollY / Math.max(1, h.scrollHeight - innerHeight)).toFixed(4));
    const r = hero.getBoundingClientRect();
    hero.style.setProperty("--p", Math.min(1, Math.max(0, -r.top / Math.max(1, r.height))).toFixed(4));
    const s = story.getBoundingClientRect();
    rail.style.setProperty("--sp", Math.min(1, Math.max(0, (innerHeight * .5 - s.top) / Math.max(1, s.height))).toFixed(4));
  };
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  addEventListener("scroll", onScroll, { passive: true }); addEventListener("resize", onScroll, { passive: true }); frame();
  if (!reduce) addEventListener("pointermove", e => {
    const r = hero.getBoundingClientRect();
    hero.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
    hero.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
  }, { passive: true });

  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: .15, rootMargin: "0px 0px -8% 0px" });
  requestAnimationFrame(() => { hero.classList.add("in"); $$(".hero .fade").forEach(n => n.classList.add("in")); $$("[data-reveal],.card,.fade:not(.hero .fade)").forEach(n => io.observe(n)); });

  const steps = $$(".step");
  const sio = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    steps.forEach(s => s.classList.toggle("on", s === e.target));
    stage.dataset.active = e.target.dataset.step;
  }), { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach(s => sio.observe(s));

  const links = $$(".links a"), nio = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) links.forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id)); }), { rootMargin: "-40% 0px -55% 0px" });
  $$("section[id]").forEach(s => nio.observe(s));
})();
