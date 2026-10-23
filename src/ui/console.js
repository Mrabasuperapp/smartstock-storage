(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const fmtBytes = n => { if (n == null) return "–"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; };
  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2200); };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed"); } };
  async function api(url, opt) {
    const r = await fetch(url, { credentials: "same-origin", ...opt });
    if (r.status === 401) { location.href = "/storage/auth/login"; throw new Error("Signed out"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || r.statusText);
    return j;
  }

  /* ---------- scroll layer: one rAF-batched pass, writes CSS variables only ---------- */
  const scrubs = $$("[data-scrub]"), story = $("#story"), rail = $(".rail i");
  let ticking = false;
  function frame() {
    ticking = false;
    const h = document.documentElement;
    h.style.setProperty("--page", (scrollY / Math.max(1, h.scrollHeight - innerHeight)).toFixed(4));
    for (const s of scrubs) {
      const r = s.getBoundingClientRect();
      s.style.setProperty("--p", Math.min(1, Math.max(0, -r.top / Math.max(1, r.height))).toFixed(4));
    }
    const r = story.getBoundingClientRect();
    rail.parentElement.style.setProperty("--sp", Math.min(1, Math.max(0, (innerHeight * .5 - r.top) / Math.max(1, r.height))).toFixed(4));
    story.style.setProperty("--sp", rail.parentElement.style.getPropertyValue("--sp"));
  }
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  addEventListener("scroll", onScroll, { passive: true }); addEventListener("resize", onScroll, { passive: true }); frame();
  if (!reduce) addEventListener("pointermove", e => {
    const hero = $(".hero"); const r = hero.getBoundingClientRect();
    hero.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
    hero.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
  }, { passive: true });

  /* ---------- reveal on enter ---------- */
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: .15, rootMargin: "0px 0px -8% 0px" });
  const observe = root => $$("[data-reveal],.drop,.card,.fade:not(.hero .fade),.row:not(.in)", root).forEach(n => io.observe(n));
  requestAnimationFrame(() => { $(".hero").classList.add("in"); $$(".hero .fade").forEach(n => n.classList.add("in")); observe(document); });

  /* ---------- sticky story: active step drives the stage ---------- */
  const stage = $("#stage"), steps = $$(".step");
  const countOnce = new Set();
  const sio = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const i = e.target.dataset.step;
    steps.forEach(s => s.classList.toggle("on", s === e.target));
    stage.dataset.active = i;
    if (i === "0" && !countOnce.has("b") && data.stats) { countOnce.add("b"); countUp($("#k-blocks"), data.stats.blocks); }
  }), { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach(s => sio.observe(s));
  function countUp(node, to) {
    if (reduce) { node.textContent = to.toLocaleString(); return; }
    const t0 = performance.now(), d = 900;
    const tick = t => { const k = Math.min(1, (t - t0) / d); node.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString(); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  /* ---------- data ---------- */
  const data = { stats: null, files: [], page: 1, total: 0 };
  const COLORS = { image: "#0070f3", video: "#8e4ec6", application: "#f5a623", text: "#10b981", other: "#8f8f8f" };
  const kind = t => { const k = `${t || ""}`.split("/")[0]; return COLORS[k] ? k : "other"; };

  async function loadStore() {
    const [stats, log, all] = await Promise.all([api("/storage/admin/store/stats"), api("/storage/admin/store/log?limit=6"), api("/storage/admin/files?pageSize=100")]);
    data.stats = stats;
    $("#k-bytes").textContent = fmtBytes(stats.blockBytes);
    $("#k-files").textContent = stats.indexedFiles;
    $("#k-free").textContent = fmtBytes(stats.diskFreeBytes);
    $("#ns").textContent = stats.namespace;
    if (stage.dataset.active === "0") { countOnce.add("b"); countUp($("#k-blocks"), stats.blocks); } else $("#k-blocks").textContent = stats.blocks.toLocaleString();
    const chips = $("#chips");
    chips.replaceChildren(...[[stats.indexedFiles + " files"], [fmtBytes(stats.blockBytes) + " stored"], ["ns " + stats.namespace], ["writes: " + (stats.policy.requireWriteToken ? "token required" : "open · " + stats.untokenedWrites.writes + " untokened")], ["reads: " + (stats.policy.publicRead ? "public" : "token required")]].map(([t], i) => { const c = el("span", null, "chip"); if (!i) c.append(el("i", null, "dot")); c.append(t); return c; }));
    const by = {}; all.files.forEach(f => { const k = kind(f.type); by[k] = (by[k] || 0) + (f.size || 0); });
    const tot = Object.values(by).reduce((a, b) => a + b, 0) || 1;
    $("#bar").replaceChildren(...Object.entries(by).map(([k, v], i) => { const s = el("i"); s.style.cssText = `width:${v / tot * 100}%;background:${COLORS[k]};transition-delay:${i * 90}ms`; return s; }));
    $("#legend").replaceChildren(...Object.entries(by).map(([k, v]) => { const s = el("span"); const b = el("b"); b.style.background = COLORS[k]; s.append(b, `${k} ${fmtBytes(v)}`); return s; }));
    $("#timeline").replaceChildren(...log.map((e, i) => { const li = el("li"); li.style.setProperty("--i", i); li.append(el("span", e.op, "op " + e.op), el("span", e.name || (e.count != null ? e.count + " files" : "removed"), "name"), el("span", new Date(e.at).toLocaleDateString(), "mono muted")); return li; }));
    $("#kv").replaceChildren(...[["Namespace", stats.namespace], ["Head", stats.headCid], ["Blockstore", stats.blockstoreDir], ["Meta", stats.metaDir]].flatMap(([k, v]) => [el("dt", k), el("dd", v || "–", "mono")]));
  }

  /* ---------- files ---------- */
  const list = $("#list");
  const skeleton = () => list.replaceChildren(...Array.from({ length: 3 }, () => el("div", null, "skel")));
  async function loadFiles(append) {
    if (!append) { data.page = 1; skeleton(); }
    const q = new URLSearchParams({ page: data.page, pageSize: 12, q: $("#q").value.trim(), type: $("#type").value });
    const r = await api("/storage/admin/files?" + q);
    data.total = r.pagination.total;
    const rows = r.files.map((f, i) => {
      const row = el("div", null, "row"); row.style.setProperty("--i", i % 12);
      const name = el("div", null, "name"); name.append(el("span", (f.name.split(".").pop() || "").slice(0, 4), "ext"), el("span", f.name));
      const acts = el("div", null, "acts");
      const open = el("a", "Open", "btn sm"); open.href = f.url; open.target = "_blank"; open.rel = "noopener";
      const cp = el("button", "Copy link", "btn sm"); cp.onclick = () => copy(location.origin + f.url);
      const del = el("button", "Delete", "btn sm danger"); del.onclick = async () => { if (!confirm("Delete " + f.name + "?")) return; try { await api("/storage/admin/files/" + encodeURIComponent(f.cid), { method: "DELETE" }); toast("Deleted"); loadFiles(); loadStore(); } catch (e) { toast(e.message); } };
      acts.append(open, cp, del);
      row.append(name, el("span", fmtBytes(f.size), "size num muted"), el("span", new Date(f.createdAt).toLocaleDateString(), "when muted"), acts);
      return row;
    });
    if (!append) list.replaceChildren();
    if (!rows.length && !append) list.append(el("div", "No files yet", "empty"));
    list.append(...rows); observe(list);
    $("#count").textContent = data.total + " file" + (data.total === 1 ? "" : "s");
    $("#more").hidden = !r.pagination.hasNext;
  }
  $("#more").onclick = () => { data.page++; loadFiles(true); };
  let qt; $("#q").oninput = () => { clearTimeout(qt); qt = setTimeout(() => loadFiles(), 250); };
  $("#type").onchange = () => loadFiles();

  async function upload(files) {
    if (!files.length) return;
    const fd = new FormData(); [...files].forEach(f => fd.append("multipleFiles", f));
    $("#dropmsg").textContent = "Uploading " + files.length + "…";
    try { await api("/storage", { method: "POST", body: fd }); toast("Uploaded"); await Promise.all([loadFiles(), loadStore()]); }
    catch (e) { toast(e.message); }
    $("#dropmsg").textContent = "Up to 50 MB each";
  }
  const drop = $("#drop");
  $("#pick").onchange = e => { upload(e.target.files); e.target.value = ""; };
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => upload(e.dataTransfer.files));

  /* ---------- access: write token ---------- */
  let access = "write";
  $$("#tacc button").forEach(b => b.onclick = () => { access = b.dataset.v; $$("#tacc button").forEach(x => x.classList.toggle("on", x === b)); });
  $("#tokform").onsubmit = async e => {
    e.preventDefault();
    const out = $("#tokout");
    try {
      const t = await api("/storage/admin/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: $("#tlabel").value, access}) });
      const curl = `curl -X POST ${location.origin}/storage \\\n  -H "Authorization: Bearer <token>" \\\n  -F "multipleFiles=@file.png"`;
      const tok = el("code", t.accessToken, "code"), ex = el("code", curl, "code");
      const row = el("div"); row.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:space-between";
      const c = el("button", "Copy token", "btn sm primary"); c.onclick = () => copy(t.accessToken);
      row.append(el("span", `${t.token.scopes.join(", ")} · never expires`, "muted"), c);
      out.replaceChildren(row, tok, ex); loadTokens();
    } catch (err) { out.replaceChildren(el("span", err.message, "err")); }
  };

  async function loadTokens() {
    const all = await api("/storage/admin/tokens");
    const rows = all.map(t => {
      const row = el("div", null, "row in"); row.style.gridTemplateColumns = "minmax(0,2fr) 120px 150px auto";
      const name = el("div", null, "name"); name.append(el("span", t.label)); name.append(el("span", t.revokedAt ? "revoked" : "active", "mono " + (t.revokedAt ? "err" : "muted")));
      const acts = el("div", null, "acts");
      if (!t.revokedAt) { const rv = el("button", "Revoke", "btn sm danger"); rv.onclick = async () => { if (!confirm("Revoke " + t.label + "? Services using it lose access immediately.")) return; try { await api("/storage/admin/tokens/" + t.id, { method: "DELETE" }); toast("Revoked"); loadTokens(); } catch (e) { toast(e.message); } }; acts.append(rv); }
      row.append(name, el("span", t.scopes.map(s => s.split(":")[1]).join("+"), "size muted"), el("span", t.lastUsedAt ? "used " + new Date(t.lastUsedAt).toLocaleDateString() : "never used", "when muted"), acts);
      return row;
    });
    $("#toklist").replaceChildren(...(rows.length ? rows : [el("div", "No tokens yet", "empty")]));
  }

  /* ---------- team: who may sign in with Google ---------- */
  async function loadTeam() {
    const admins = await api("/storage/admin/team");
    const rows = admins.map(a => {
      const row = el("div", null, "row in"); row.style.gridTemplateColumns = "minmax(0,2fr) 120px 150px auto";
      const name = el("div", null, "name"); name.append(el("span", a.email));
      const acts = el("div", null, "acts");
      if (!a.owner) { const rm = el("button", "Remove", "btn sm danger"); rm.onclick = async () => { if (!confirm("Remove " + a.email + "? Their sessions end immediately.")) return; try { await api("/storage/admin/team/" + encodeURIComponent(a.email), { method: "DELETE" }); toast("Removed"); loadTeam(); } catch (e) { toast(e.message); } }; acts.append(rm); }
      row.append(name, el("span", a.owner ? "owner" : "admin", "size muted"), el("span", a.owner ? "set on server" : "added " + (a.addedAt ? new Date(a.addedAt).toLocaleDateString() : ""), "when muted"), acts);
      return row;
    });
    $("#teamlist").replaceChildren(...(rows.length ? rows : [el("div", "No admins yet", "empty")]));
  }
  $("#teamform").onsubmit = async e => {
    e.preventDefault();
    try { await api("/storage/admin/team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("#temail").value }) }); $("#temail").value = ""; toast("Added"); loadTeam(); }
    catch (err) { toast(err.message); }
  };
  async function showWho() {
    try { const me = await api("/storage/auth/me"); const w = $("#who"); w.textContent = me.name || me.subject; w.title = me.subject; w.hidden = false; } catch { }
  }

  /* ---------- integrity ---------- */
  const vmsg = $("#vmsg");
  $("#verify").onclick = async e => {
    const b = e.currentTarget; b.disabled = true; vmsg.textContent = "Checking…";
    try {
      const r = await api("/storage/admin/store/verify", { method: "POST" });
      vmsg.textContent = `${r.ok} ok · ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"} · ${r.checked} checked`;
      $("#issues").replaceChildren(...r.problems.map(p => { const d = el("div", null, "issue"); const body = el("div"); body.append(el("div", p.name), el("div", p.cid, "mono muted")); d.append(el("span", p.status, "tag"), body); return d; }));
    } catch (err) { vmsg.textContent = err.message; }
    b.disabled = false;
  };
  $("#rebuild").onclick = async () => {
    if (!confirm("Scan every block to find the newest index entry?")) return;
    try { const r = await api("/storage/admin/store/rebuild", { method: "POST" }); vmsg.textContent = r.rebuilt ? `Rebuilt · ${r.count} files` : "No index entries found"; loadStore(); loadFiles(); } catch (err) { vmsg.textContent = err.message; }
  };
  $("#out").onclick = async () => { await fetch("/storage/auth/session", { method: "DELETE" }); location.href = "/storage/auth/login"; };

  /* nav highlight */
  const links = $$(".links a"); const nio = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) links.forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id)); }), { rootMargin: "-40% 0px -55% 0px" });
  $$("section[id]").forEach(s => nio.observe(s));

  loadTokens().catch(() => {}); loadTeam().catch(() => {}); showWho(); loadStore().catch(e => toast(e.message)); loadFiles().catch(e => toast(e.message));
})();
