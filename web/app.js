const $ = (id) => document.getElementById(id);

const state = {
  summary: null,
  hotels: [],
  active: 0,
};

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function pill(kind) {
  return `<span class="pill ${kind}">${kind}</span>`;
}

function renderOverview(summary) {
  const top = summary.top_hotels
    .map((h) => {
      const max = summary.top_hotels[0].hosts;
      const pct = Math.max(6, Math.round((h.hosts / max) * 100));
      return `<div class="bar-row clickable" data-code="${h.code}">
        <div class="name">${h.code}</div>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div>
        <div class="n">${fmt(h.hosts)} hosts</div>
      </div>`;
    })
    .join("");

  $("overview").innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="label">Hosts</div><div class="value">${fmt(summary.host_count)}</div><div class="sub">Qualys administrator group export</div></div>
      <div class="kpi"><div class="label">Hotel codes</div><div class="value">${fmt(summary.hotel_count)}</div><div class="sub">${fmt(summary.prefix_counts.H || 0)} H · ${fmt(summary.prefix_counts.V || 0)} V</div></div>
      <div class="kpi"><div class="label">Uncoded hosts</div><div class="value">${fmt(summary.hosts_without_code)}</div><div class="sub">No H/V + 4-char code in DNS, NetBIOS or tags</div></div>
      <div class="kpi"><div class="label">Report generated</div><div class="value" style="font-size:18px;margin-top:10px">${summary.generated.replace("T", " ").replace("Z", " UTC")}</div>
        <div class="sub">${escapeHtml(summary.source || "")}</div></div>
    </div>
    ${summary.stale ? `<p class="status">A newer XML is in the folder: ${escapeHtml(summary.latest_xml)}. Reload to parse it.</p>` : ""}
    <div class="toolbar-inline">
      <button type="button" class="linkish" id="reload-xml">Reload from latest XML</button>
      <span class="muted" id="reload-status"></span>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>Largest hotels by host count</h2>
        <div class="body">${top}</div>
      </div>
      <div class="card">
        <h2>How to filter</h2>
        <div class="empty">
          Type a hotel code such as <span class="mono">H1401</span> or <span class="mono">V0011</span>.
          Matching is based on DNS, NetBIOS and Qualys asset tags. Click a hotel to drill into workstation vs server statistics and the administrator accounts on each.
        </div>
      </div>
    </div>
  `;
  $("overview").querySelectorAll("[data-code]").forEach((el) => {
    el.addEventListener("click", () => loadHotel(el.dataset.code));
  });
  $("reload-xml").onclick = async () => {
    const status = $("reload-status");
    status.textContent = "Parsing the latest XML. This takes about 15 seconds…";
    try {
      const res = await fetch("/api/reload", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      state.summary = await api("/api/summary");
      renderOverview(state.summary);
      $("reload-status").textContent = data.message;
    } catch (err) {
      $("reload-status").textContent = err.message;
    }
  };
}

function renderHotel(data) {
  $("overview").hidden = true;
  $("hotel-view").hidden = false;
  $("hotel-input").value = data.code;

  window.__hotel = data;
  window.__filters = { role: "all", kind: "", presence: "", query: "" };

  const wks = data.roles.workstation;
  const srv = data.roles.server;
  const presence = data.presence_counts || {};

  $("hotel-view").innerHTML = `
    <div class="hotel-head">
      <div>
        <p class="crumb"><button type="button" class="text-link" id="back">Overview</button> / ${data.code}</p>
        <p class="eyebrow">Hotel drilldown</p>
        <h2>${data.code}</h2>
      </div>
      <button class="linkish" id="export-csv">Export CSV</button>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="label">Hosts</div><div class="value">${fmt(data.host_count)}</div>
        <div class="sub">${fmt(wks.host_count)} workstations · ${fmt(srv.host_count)} servers</div></div>
      <div class="kpi"><div class="label">Unique admins</div><div class="value">${fmt(data.unique_admin_count)}</div>
        <div class="sub">${fmt(presence.both || 0)} on both roles · ${fmt(presence.workstation || 0)} WKS only · ${fmt(presence.server || 0)} server only</div></div>
      <div class="kpi role-kpi" data-role="workstation">
        <div class="label">Workstations</div>
        <div class="value">${fmt(wks.host_count)}</div>
        <div class="sub">${fmt(wks.unique_admin_count)} unique admins · ${fmt(wks.local_unique)} local · ${fmt(wks.domain_unique)} domain</div>
      </div>
      <div class="kpi role-kpi" data-role="server">
        <div class="label">Servers</div>
        <div class="value">${fmt(srv.host_count)}</div>
        <div class="sub">${fmt(srv.unique_admin_count)} unique admins · ${fmt(srv.local_unique)} local · ${fmt(srv.domain_unique)} domain</div>
      </div>
    </div>

    <div class="grid-2 stats-grid">
      <div class="card">
        <h2>Workstation admin mix</h2>
        <div class="body pad">${roleMix(wks)}</div>
      </div>
      <div class="card">
        <h2>Server admin mix</h2>
        <div class="body pad">${roleMix(srv)}</div>
      </div>
    </div>

    <div class="card lateral-card">
      <h2>Lateral movement</h2>
      <div class="toolbar">
        <label class="muted" for="lateral-account">If this account is compromised</label>
        <select id="lateral-account"></select>
        <label class="switch" title="Administrator, AdminDevice, and AdminIT use unique rotating passwords, so they are not treated as dump-and-reuse paths.">
          <input type="checkbox" id="lateral-exclude-rotating" ${excludeRotatingLocals() ? "checked" : ""} />
          <span class="switch-ui"></span>
          <span>Exclude rotating locals</span>
        </label>
        <span class="muted" id="lateral-summary"></span>
      </div>
      <div class="lateral-layout">
        <div class="graph-wrap">
          <div class="graph-nav">
            <button type="button" id="lateral-zoom-in" title="Zoom in">+</button>
            <button type="button" id="lateral-zoom-out" title="Zoom out">−</button>
            <button type="button" id="lateral-zoom-reset" title="Reset view">Reset</button>
          </div>
          <svg id="lateral-graph" viewBox="0 0 920 540" role="img" aria-label="Lateral movement graph"></svg>
          <div id="lateral-tip" class="graph-tip" hidden></div>
          <div class="graph-legend">
            <span><i class="swatch compromised"></i> Compromised account</span>
            <span><i class="swatch workstation"></i> Workstation</span>
            <span><i class="swatch server"></i> Server</span>
            <span><i class="swatch hop"></i> Extra host via dumped local</span>
            <span class="muted">Hover a node for the computer name · click a yellow account to list its machines</span>
          </div>
        </div>
        <div class="lateral-side">
          <div class="mini-label">Blast radius</div>
          <div id="lateral-blast" class="lateral-blast"></div>
          <div id="lateral-focus"></div>
          <div class="mini-label">Second hop (local hash reuse)</div>
          <p class="muted hop-note" id="lateral-hop-note"></p>
          <div id="lateral-hops"></div>
        </div>
      </div>
    </div>

    <div class="tabs" id="role-tabs">
      <button type="button" class="tab active" data-role="all">All hosts</button>
      <button type="button" class="tab" data-role="workstation">Workstations (${fmt(wks.host_count)})</button>
      <button type="button" class="tab" data-role="server">Servers (${fmt(srv.host_count)})</button>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2 id="host-heading">Hosts</h2>
        <div class="toolbar">
          <input id="host-filter" placeholder="Filter hosts" />
          <span class="muted" id="host-count"></span>
        </div>
        <div class="body" id="host-table"></div>
      </div>
      <div class="card">
        <h2 id="admin-heading">Administrator accounts</h2>
        <div class="toolbar">
          <input id="admin-filter" placeholder="Filter accounts" />
          <select id="kind-filter">
            <option value="">All kinds</option>
            <option value="domain">Domain</option>
            <option value="local">Local</option>
            <option value="other">Other</option>
          </select>
          <select id="presence-filter">
            <option value="">WKS and servers</option>
            <option value="workstation">Workstations only</option>
            <option value="server">Servers only</option>
            <option value="both">On both roles</option>
          </select>
        </div>
        <div class="body" id="admin-table"></div>
      </div>
    </div>
  `;

  $("back").onclick = () => {
    $("hotel-view").hidden = true;
    $("overview").hidden = false;
    history.replaceState({}, "", "/");
  };
  $("export-csv").onclick = exportCsv;
  $("host-filter").oninput = renderHostTable;
  $("admin-filter").oninput = renderAdminTable;
  $("kind-filter").onchange = renderAdminTable;
  $("presence-filter").onchange = renderAdminTable;
  $("role-tabs").querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setRole(tab.dataset.role));
  });
  $("hotel-view").querySelectorAll(".role-kpi").forEach((el) => {
    el.addEventListener("click", () => setRole(el.dataset.role));
  });
  setupLateral();
  renderHostTable();
  renderAdminTable();
}

function roleMix(stats) {
  const kinds = stats.kind_counts || {};
  const total = Math.max(1, stats.memberships);
  const rows = [
    ["Domain", kinds.domain || 0, "domain"],
    ["Local", kinds.local || 0, "local"],
    ["Other", kinds.other || 0, "other"],
  ];
  if (!stats.host_count) {
    return `<div class="empty">No hosts in this role.</div>`;
  }
  const os = (stats.os_counts || [])
    .map(([name, n]) => `<div class="os-line"><span>${escapeHtml(name)}</span><span class="muted">${fmt(n)}</span></div>`)
    .join("");
  return `
    <div class="mix">
      ${rows.map(([label, n, cls]) => `
        <div class="mix-row">
          <div class="mix-label">${label}</div>
          <div class="track"><div class="fill ${cls}" style="width:${Math.round((n / total) * 100)}%"></div></div>
          <div class="n">${fmt(n)}</div>
        </div>
      `).join("")}
      <div class="muted mix-foot">${fmt(stats.memberships)} memberships across ${fmt(stats.host_count)} hosts</div>
      ${os}
    </div>
  `;
}

function setRole(role) {
  window.__filters.role = role;
  $("role-tabs").querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.role === role);
  });
  $("hotel-view").querySelectorAll(".role-kpi").forEach((el) => {
    el.classList.toggle("active", el.dataset.role === role);
  });
  const labels = {
    all: ["Hosts", "Administrator accounts"],
    workstation: ["Workstations", "Admins on workstations"],
    server: ["Servers", "Admins on servers"],
  };
  $("host-heading").textContent = labels[role][0];
  $("admin-heading").textContent = labels[role][1];
  renderHostTable();
  renderAdminTable();
}

function rolePill(role) {
  return `<span class="pill ${role}">${role === "workstation" ? "WKS" : "Server"}</span>`;
}

function adminDisplayName(admin) {
  return admin.grouped ? admin.account : admin.name;
}

const ROTATING_LOCALS = new Set([
  "administrator",
  "administrateur",
  "admindevice",
  "adminit",
]);
const ROTATING_STORAGE_KEY = "lateralExcludeRotating";

function localSamName(admin) {
  return String(admin.account || admin.name || "").split("\\").pop().toLowerCase();
}

function isRotatingLocal(admin) {
  return ROTATING_LOCALS.has(localSamName(admin));
}

function excludeRotatingLocals() {
  try {
    const stored = localStorage.getItem(ROTATING_STORAGE_KEY);
    if (stored === null) return true;
    return stored !== "0";
  } catch {
    return true;
  }
}

function setExcludeRotatingLocals(on) {
  try {
    localStorage.setItem(ROTATING_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
}

function setupLateral() {
  const data = window.__hotel;
  const select = $("lateral-account");
  const ranked = [...data.unique_admins].sort((a, b) => {
    if (a.kind === "local" && b.kind !== "local") return -1;
    if (b.kind === "local" && a.kind !== "local") return 1;
    return b.host_count - a.host_count;
  });
  window.__lateralRanked = ranked;
  window.__lateralFocus = null;
  resetLateralView();
  select.innerHTML = ranked
    .map((a, i) => {
      const label = `${adminDisplayName(a)} · ${a.kind} · ${a.host_count} host${a.host_count === 1 ? "" : "s"}`;
      return `<option value="${i}">${escapeHtml(label)}</option>`;
    })
    .join("");
  select.onchange = () => {
    window.__lateralFocus = null;
    resetLateralView();
    drawLateral(ranked[Number(select.value)]);
  };
  const toggle = $("lateral-exclude-rotating");
  toggle.checked = excludeRotatingLocals();
  toggle.onchange = () => {
    setExcludeRotatingLocals(toggle.checked);
    window.__lateralFocus = null;
    drawLateral(ranked[Number(select.value)]);
  };
  $("lateral-zoom-in").onclick = () => zoomLateral(1.25);
  $("lateral-zoom-out").onclick = () => zoomLateral(1 / 1.25);
  $("lateral-zoom-reset").onclick = () => {
    resetLateralView();
    applyLateralView();
  };
  bindLateralNav($("lateral-graph"));
  drawLateral(ranked[0]);
}

function hostByLabel(label) {
  const data = window.__hotel;
  return data.hosts.find((h) => (h.dns || h.netbios || h.ip) === label);
}

function hostMeta(label) {
  const host = hostByLabel(label) || {};
  const dns = host.dns || "";
  const netbios = host.netbios || "";
  const name = netbios || dns.split(".")[0] || host.ip || String(label || "");
  return {
    label,
    role: host.role || "workstation",
    ip: host.ip || "",
    dns,
    netbios,
    name,
    short: shortLabel(name, 22),
  };
}

function polar(cx, cy, radius, index, total) {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(total, 1);
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

function outwardPolar(hx, hy, cx, cy, radius, index, total) {
  const base = Math.atan2(hy - cy, hx - cx);
  const span = Math.min(Math.PI * 0.9, 0.7 * Math.max(total, 1));
  const angle = total === 1 ? base : base - span / 2 + (span * index) / Math.max(total - 1, 1);
  return [hx + radius * Math.cos(angle), hy + radius * Math.sin(angle)];
}

function shortLabel(text, max = 22) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function dumpableLocals(except) {
  const skipRotating = excludeRotatingLocals();
  return window.__hotel.unique_admins.filter((a) => {
    if (a === except) return false;
    if (a.kind !== "local") return false;
    if (skipRotating && isRotatingLocal(a)) return false;
    return true;
  });
}

function extraHostsFromHost(label, except) {
  const extras = new Map();
  for (const admin of dumpableLocals(except)) {
    if (!(admin.hosts || []).includes(label)) continue;
    for (const h of admin.hosts || []) {
      if (h === label) continue;
      if (!extras.has(h)) extras.set(h, { label: h, via: [] });
      extras.get(h).via.push(admin);
    }
  }
  return [...extras.values()].sort((a, b) => b.via.length - a.via.length || a.label.localeCompare(b.label));
}

function secondHops(compromised) {
  const direct = new Set(compromised.hosts || []);
  const hops = [];
  for (const other of dumpableLocals(compromised)) {
    const overlap = (other.hosts || []).some((h) => direct.has(h));
    if (!overlap) continue;
    const extra = (other.hosts || []).filter((h) => !direct.has(h));
    if (!extra.length) continue;
    hops.push({ admin: other, extra, origin: (other.hosts || []).filter((h) => direct.has(h)) });
  }
  hops.sort((a, b) => b.extra.length - a.extra.length);
  return hops;
}

function lateralViewState() {
  if (!window.__lateralView) window.__lateralView = { x: 0, y: 0, k: 1 };
  return window.__lateralView;
}

function resetLateralView() {
  window.__lateralView = { x: 0, y: 0, k: 1 };
}

function applyLateralView() {
  const scene = $("lateral-graph") && $("lateral-graph").querySelector(".lateral-scene");
  if (!scene) return;
  const { x, y, k } = lateralViewState();
  scene.setAttribute("transform", `matrix(${k} 0 0 ${k} ${x} ${y})`);
}

function svgPoint(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return [0, 0];
  const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return [pt.x, pt.y];
}

function zoomLateral(factor, clientX, clientY) {
  const svg = $("lateral-graph");
  if (!svg) return;
  const view = lateralViewState();
  const vb = svg.viewBox.baseVal;
  const [mx, my] = clientX == null
    ? [vb.width / 2, vb.height / 2]
    : svgPoint(svg, clientX, clientY);
  const wx = (mx - view.x) / view.k;
  const wy = (my - view.y) / view.k;
  view.k = Math.min(8, Math.max(0.4, view.k * factor));
  view.x = mx - wx * view.k;
  view.y = my - wy * view.k;
  applyLateralView();
}

function bindLateralNav(svg) {
  let pan = null;
  let moved = false;
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomLateral(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: lateralViewState().x, vy: lateralViewState().y };
    moved = false;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("is-panning");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pan || e.pointerId !== pan.id) {
      showLateralTip(svg, e);
      if (!pan) return;
    }
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (Math.hypot(dx, dy) > 4) moved = true;
    const scale = svg.viewBox.baseVal.width / Math.max(svg.clientWidth, 1);
    const view = lateralViewState();
    view.x = pan.vx + dx * scale;
    view.y = pan.vy + dy * scale;
    applyLateralView();
    hideLateralTip();
  });
  const endPan = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    window.__lateralPanned = moved;
    pan = null;
    svg.classList.remove("is-panning");
  };
  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);
  svg.addEventListener("pointerleave", hideLateralTip);
  svg.addEventListener("click", (e) => {
    hideLateralTip();
    if (window.__lateralPanned) {
      window.__lateralPanned = false;
      return;
    }
    const node = e.target.closest(".g-node");
    if (!node || !svg.contains(node)) {
      if (window.__lateralFocus) {
        window.__lateralFocus = null;
        drawLateral(window.__lateralAdmin);
      }
      return;
    }
    onLateralNodeClick(node.dataset);
  });
}

function hideLateralTip() {
  const tip = $("lateral-tip");
  if (tip) tip.hidden = true;
}

function showLateralTip(svg, e) {
  const tip = $("lateral-tip");
  if (!tip) return;
  const node = e.target.closest(".g-node");
  if (!node || !svg.contains(node)) {
    tip.hidden = true;
    return;
  }
  const kind = node.dataset.kind;
  let html = "";
  if (kind === "host" || kind === "hop-host") {
    const meta = hostMeta(node.dataset.host);
    const account = node.dataset.account;
    html = `
      <div class="mono strong">${escapeHtml(meta.name)}</div>
      ${meta.dns ? `<div class="muted">${escapeHtml(meta.dns)}</div>` : ""}
      <div>${meta.role === "server" ? "Server" : "Workstation"}${meta.ip ? ` · ${escapeHtml(meta.ip)}` : ""}</div>
      <div class="muted">${account
        ? `Also has local account ${escapeHtml(account)}`
        : `Has ${escapeHtml(adminDisplayName(window.__lateralAdmin))} as local admin`}</div>
    `;
  } else if (kind === "hop-account" || kind === "hop-cluster") {
    const hopAdmin = (window.__hotel.unique_admins || []).find(
      (a) => a.kind === "local" && a.account === node.dataset.account
    );
    const hosts = (hopAdmin && hopAdmin.hosts) || [];
    html = `
      <div class="mono strong">${escapeHtml(node.dataset.account)}</div>
      <div>Local account on ${fmt(hosts.length)} computer${hosts.length === 1 ? "" : "s"}</div>
      <div class="muted">Click to list every machine this name appears on.</div>
    `;
  } else if (kind === "compromised") {
    const admin = window.__lateralAdmin;
    html = `
      <div class="mono strong">${escapeHtml(adminDisplayName(admin))}</div>
      <div>Compromised account · ${fmt((admin.hosts || []).length)} computers</div>
    `;
  }
  if (!html) {
    tip.hidden = true;
    return;
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const wrap = svg.parentElement.getBoundingClientRect();
  const x = e.clientX - wrap.left + 14;
  const y = e.clientY - wrap.top + 14;
  tip.style.left = `${Math.min(x, wrap.width - 220)}px`;
  tip.style.top = `${Math.min(y, wrap.height - 90)}px`;
}

function onLateralNodeClick(dataset) {
  const kind = dataset.kind;
  if (kind === "compromised") {
    window.__lateralFocus = null;
    drawLateral(window.__lateralAdmin);
    return;
  }
  if (kind === "hop-account" || kind === "hop-cluster") {
    window.__lateralFocus = { type: "hop", account: dataset.account };
    drawLateral(window.__lateralAdmin);
    return;
  }
  if (kind === "host" || kind === "hop-host") {
    window.__lateralFocus = { type: "host", label: dataset.host };
    drawLateral(window.__lateralAdmin);
    return;
  }
  if (kind === "wks-cluster") {
    window.__lateralFocus = { type: "wks-cluster" };
    drawLateral(window.__lateralAdmin);
  }
}

function renderFocusPanel(admin, hops, hiddenWks) {
  const focus = window.__lateralFocus;
  const box = $("lateral-focus");
  if (!focus) {
    box.innerHTML = `
      <div class="mini-label">This account is on</div>
      <p class="muted hop-note">${escapeHtml(adminDisplayName(admin))} is in the local Administrators group on these computers.</p>
      ${hostPresenceTable(admin.hosts || [])}
    `;
    return;
  }
  if (focus.type === "hop") {
    const hop = hops.find((h) => h.admin.account === focus.account);
    if (!hop) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = `
      <div class="mini-label">This account is on</div>
      <div class="focus-head mono">${escapeHtml(hop.admin.account)}</div>
      <p class="muted hop-note">Same local name on the machines below. Dump it from a reached host, then reuse it where it already exists.</p>
      <div class="mini-label">Dumped from (already reached)</div>
      ${hostPresenceTable(hop.origin)}
      <div class="mini-label">Also local admin on</div>
      ${hostPresenceTable(hop.extra)}
      <button type="button" class="linkish" id="focus-set-compromised">Set as compromised account</button>
    `;
    $("focus-set-compromised").onclick = () => selectLateralAdmin(hop.admin);
    return;
  }
  if (focus.type === "host") {
    const meta = hostMeta(focus.label);
    const extras = extraHostsFromHost(focus.label, admin);
    const locals = dumpableLocals(admin).filter((a) => (a.hosts || []).includes(focus.label));
    box.innerHTML = `
      <div class="mini-label">This computer</div>
      <div class="focus-head mono">${escapeHtml(meta.name)}</div>
      ${meta.dns ? `<div class="muted tiny">${escapeHtml(meta.dns)}</div>` : ""}
      <div class="muted">${meta.role === "server" ? "Server" : "Workstation"}${meta.ip ? ` · ${escapeHtml(meta.ip)}` : ""}</div>
      <div class="mini-label">Local accounts on it</div>
      ${locals.length
        ? `<ul class="account-on-host">${locals.map((a) => {
            const n = (a.hosts || []).length;
            return `<li><span class="mono">${escapeHtml(a.account)}</span> <span class="muted">on ${fmt(n)} computer${n === 1 ? "" : "s"}</span></li>`;
          }).join("")}</ul>`
        : `<div class="muted">No other dumpable local accounts on this machine.</div>`}
      <div class="mini-label">Those accounts also exist on</div>
      ${hostPresenceTable(extras)}
    `;
    return;
  }
  if (focus.type === "wks-cluster") {
    box.innerHTML = `
      <div class="mini-label">More workstations</div>
      <p class="muted hop-note">${fmt(hiddenWks.length)} additional workstations with this account.</p>
      ${hostPresenceTable(hiddenWks.map((h) => h.label))}
    `;
  }
}

function hostPresenceTable(items) {
  const rows = (items || []).map((item) => {
    if (typeof item === "string") return { meta: hostMeta(item), via: [] };
    return { meta: hostMeta(item.label), via: item.via || [] };
  }).sort((a, b) => {
    if (a.meta.role !== b.meta.role) return a.meta.role === "server" ? -1 : 1;
    return a.meta.name.localeCompare(b.meta.name, undefined, { sensitivity: "base" });
  });
  if (!rows.length) return `<div class="muted">No computers.</div>`;
  const showVia = rows.some((r) => r.via.length);
  return `<table class="presence-table">
    <thead><tr><th>Computer</th><th>Role</th><th>IP</th>${showVia ? "<th>Via</th>" : ""}</tr></thead>
    <tbody>
      ${rows.map((row) => `
        <tr class="hop-row presence-row" data-host="${escapeHtml(row.meta.label)}">
          <td>
            <div class="mono">${escapeHtml(row.meta.name)}</div>
            ${row.meta.dns && row.meta.dns.toLowerCase() !== row.meta.name.toLowerCase()
              ? `<div class="muted tiny">${escapeHtml(row.meta.dns)}</div>` : ""}
          </td>
          <td>${rolePill(row.meta.role)}</td>
          <td class="mono muted">${escapeHtml(row.meta.ip || "—")}</td>
          ${showVia ? `<td class="muted">${row.via.length ? escapeHtml(row.via.map((a) => a.account).join(", ")) : "—"}</td>` : ""}
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}

function drawLateral(admin) {
  if (!admin) return;
  window.__lateralAdmin = admin;
  const data = window.__hotel;
  const hops = secondHops(admin);
  const directHosts = (admin.hosts || []).map(hostMeta);
  const servers = directHosts.filter((h) => h.role === "server");
  const workstations = directHosts.filter((h) => h.role !== "server");
  const extraHostSet = new Set();
  hops.forEach((h) => h.extra.forEach((x) => extraHostSet.add(x)));
  const extraCount = extraHostSet.size;
  const pct = data.host_count ? Math.round((directHosts.length / data.host_count) * 100) : 0;
  const focus = window.__lateralFocus;

  $("lateral-summary").textContent = `${fmt(directHosts.length)} hosts reached (${pct}% of site)`;
  $("lateral-hop-note").textContent = excludeRotatingLocals()
    ? "If the attacker dumps SAM/LSA on a reached host, other local accounts that also appear elsewhere can extend the path. Administrator, AdminDevice, and AdminIT are excluded — they use unique rotating passwords."
    : "If the attacker dumps SAM/LSA on a reached host, other local accounts that also appear elsewhere can extend the path. Assumes the same local name reuses a password or hash.";
  $("lateral-blast").innerHTML = `
    <div class="blast-line"><strong>${fmt(directHosts.length)}</strong> hosts with this account as local admin</div>
    <div class="blast-line">${fmt(workstations.length)} workstations · ${fmt(servers.length)} servers</div>
    <div class="blast-line">${fmt(extraCount)} additional host${extraCount === 1 ? "" : "s"} reachable if a local hash is dumped and reused</div>
  `;
  $("lateral-hops").innerHTML = hops.length
    ? `<table>
        <thead><tr><th>Local account</th><th>Extra hosts</th></tr></thead>
        <tbody>
          ${hops.slice(0, 12).map((h) => `
            <tr class="hop-row${focus && focus.type === "hop" && focus.account === h.admin.account ? " selected" : ""}" data-account="${escapeHtml(h.admin.account)}">
              <td class="mono">${escapeHtml(h.admin.account)}</td>
              <td>${fmt(h.extra.length)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${hops.length > 12 ? `<div class="muted">Showing 12 of ${fmt(hops.length)} dump-and-reuse paths.</div>` : ""}`
    : `<div class="muted">No extra hosts. Other local accounts on these machines are not reused outside this blast radius.</div>`;

  const svg = $("lateral-graph");
  const cx = 390;
  const cy = 270;
  const maxWks = 40;
  const shownWks = workstations.slice(0, maxWks);
  const hiddenWks = workstations.slice(maxWks);
  const extraShown = hops.slice(0, 6);

  const lit = new Set();
  let hostExtras = [];
  if (focus && focus.type === "hop") {
    const hop = hops.find((h) => h.admin.account === focus.account);
    if (hop) {
      lit.add(`account:${hop.admin.account}`);
      hop.extra.forEach((h) => lit.add(`host:${h}`));
      hop.origin.forEach((h) => lit.add(`host:${h}`));
    }
  } else if (focus && focus.type === "host") {
    lit.add(`host:${focus.label}`);
    hostExtras = extraHostsFromHost(focus.label, admin);
    hostExtras.forEach((row) => {
      lit.add(`host:${row.label}`);
      row.via.forEach((a) => lit.add(`account:${a.account}`));
    });
    dumpableLocals(admin)
      .filter((a) => (a.hosts || []).includes(focus.label))
      .forEach((a) => lit.add(`account:${a.account}`));
  } else if (focus && focus.type === "wks-cluster") {
    hiddenWks.forEach((h) => lit.add(`host:${h.label}`));
    lit.add("wks-cluster");
  }

  const dimmed = Boolean(focus && lit.size);
  const lines = [];
  const nodes = [];

  extraShown.forEach((hop, i) => {
    const [x, y] = polar(cx, cy, 290, i, extraShown.length);
    const hopLit = !dimmed || lit.has(`account:${hop.admin.account}`);
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge hop${hopLit ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 12, cls: "hop-account",
      kind: "hop-account",
      key: `account:${hop.admin.account}`,
      account: hop.admin.account,
      label: hop.admin.account,
      sub: `+${hop.extra.length} extra`,
      title: `${hop.admin.account} is a local admin on ${hop.origin.length} reached computer(s) and ${hop.extra.length} more`,
    });
  });

  if (focus && focus.type === "hop") {
    const hop = extraShown.find((h) => h.admin.account === focus.account)
      || hops.find((h) => h.admin.account === focus.account);
    const hopNode = nodes.find((n) => n.kind === "hop-account" && n.account === focus.account);
    if (hop && hopNode) {
      hop.extra.forEach((label, j) => {
        const meta = hostMeta(label);
        const [ex, ey] = outwardPolar(hopNode.x, hopNode.y, cx, cy, 72, j, hop.extra.length);
        lines.push(`<line x1="${hopNode.x}" y1="${hopNode.y}" x2="${ex}" y2="${ey}" class="edge hop" />`);
        nodes.push({
          x: ex, y: ey, r: 9,
          cls: meta.role === "server" ? "hop-host server" : "hop-host",
          kind: "hop-host",
          key: `host:${label}`,
          host: label,
          account: hop.admin.account,
          label: meta.short,
          title: `${meta.name}\n${label}\n${meta.ip}\n${meta.role}`,
        });
      });
    }
  }

  servers.forEach((h, i) => {
    const [x, y] = polar(cx, cy, 118, i, Math.max(servers.length, 1));
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge${!dimmed || lit.has(`host:${h.label}`) ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 12, cls: "server",
      kind: "host",
      key: `host:${h.label}`,
      host: h.label,
      label: h.short,
      title: `${h.name}\n${h.dns || h.label}\n${h.ip}\nserver`,
    });
  });

  shownWks.forEach((h, i) => {
    const [x, y] = polar(cx, cy, 208, i, shownWks.length + (hiddenWks.length ? 1 : 0));
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge${!dimmed || lit.has(`host:${h.label}`) ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 8, cls: "workstation",
      kind: "host",
      key: `host:${h.label}`,
      host: h.label,
      label: h.short,
      title: `${h.name}\n${h.dns || h.label}\n${h.ip}\nworkstation`,
    });
  });
  if (hiddenWks.length) {
    const [x, y] = polar(cx, cy, 208, shownWks.length, shownWks.length + 1);
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge${!dimmed || lit.has("wks-cluster") ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 16, cls: "workstation cluster",
      kind: "wks-cluster",
      key: "wks-cluster",
      label: `+${hiddenWks.length} WKS`,
      title: `${hiddenWks.length} more workstations`,
    });
  }

  if (focus && focus.type === "hop") {
    const hopNode = nodes.find((n) => n.kind === "hop-account" && n.account === focus.account);
    const hop = hops.find((h) => h.admin.account === focus.account);
    if (hopNode && hop) {
      hop.origin.forEach((label) => {
        const origin = nodes.find((n) => n.host === label && n.kind === "host");
        if (!origin) return;
        lines.push(`<line x1="${origin.x}" y1="${origin.y}" x2="${hopNode.x}" y2="${hopNode.y}" class="edge hop" />`);
      });
    }
  }

  if (focus && focus.type === "host") {
    const origin = nodes.find((n) => n.host === focus.label && n.kind === "host")
      || nodes.find((n) => n.host === focus.label);
    const ox = origin ? origin.x : cx;
    const oy = origin ? origin.y : cy;
    const extrasToPlace = hostExtras.filter((row) => !nodes.some((n) => n.host === row.label));
    extrasToPlace.slice(0, 12).forEach((row, j) => {
      const meta = hostMeta(row.label);
      const [ex, ey] = outwardPolar(ox, oy, cx, cy, 64, j, Math.min(extrasToPlace.length, 12));
      nodes.push({
        x: ex, y: ey, r: 8,
        cls: meta.role === "server" ? "hop-host server" : "hop-host",
        kind: "hop-host",
        key: `host:${row.label}`,
        host: row.label,
        label: meta.short,
        title: `${meta.name}\n${row.label}\n${meta.ip}\nvia ${(row.via || []).map((a) => a.account).join(", ")}`,
      });
    });
    hostExtras.forEach((row) => {
      const target = nodes.find((n) => n.host === row.label);
      if (!target) return;
      lines.push(`<line x1="${ox}" y1="${oy}" x2="${target.x}" y2="${target.y}" class="edge hop" />`);
    });
  }

  nodes.push({
    x: cx, y: cy, r: 28, cls: "compromised",
    kind: "compromised",
    key: "compromised",
    label: shortLabel(adminDisplayName(admin), 16),
    title: `${adminDisplayName(admin)}\n${admin.kind}\n${admin.host_count} hosts`,
  });

  svg.innerHTML = `
    <rect class="graph-bg" width="920" height="540" fill="#0f1419" />
    <g class="lateral-scene">
      ${lines.join("")}
      ${nodes.map((n) => {
        const isLit = !dimmed || n.kind === "compromised" || lit.has(n.key);
        const focused = (focus && focus.type === "host" && n.host === focus.label)
          || (focus && focus.type === "hop" && n.account === focus.account && n.kind !== "hop-host");
        return `
      <g class="g-node${isLit ? "" : " dim"}${focused ? " focused" : ""}" data-kind="${escapeHtml(n.kind || "")}" data-host="${escapeHtml(n.host || "")}" data-account="${escapeHtml(n.account || "")}">
        <title>${escapeHtml(n.title)}</title>
        <circle cx="${n.x}" cy="${n.y}" r="${n.r + 10}" class="hit" />
        <circle cx="${n.x}" cy="${n.y}" r="${n.r}" class="node ${n.cls}" />
        <text x="${n.x}" y="${n.y + n.r + 12}" class="node-label">
          <tspan x="${n.x}" dy="0">${escapeHtml(n.label)}</tspan>
          ${n.sub ? `<tspan x="${n.x}" dy="11" class="node-sub">${escapeHtml(n.sub)}</tspan>` : ""}
        </text>
      </g>`;
      }).join("")}
    </g>
  `;
  applyLateralView();
  renderFocusPanel(admin, hops, hiddenWks);
  $("lateral-hops").querySelectorAll(".hop-row").forEach((row) => {
    row.addEventListener("click", () => {
      window.__lateralFocus = { type: "hop", account: row.dataset.account };
      drawLateral(admin);
    });
  });
  $("lateral-focus").querySelectorAll(".presence-row").forEach((row) => {
    row.addEventListener("click", () => {
      window.__lateralFocus = { type: "host", label: row.dataset.host };
      drawLateral(admin);
    });
  });
}

function selectLateralAdmin(admin) {
  const ranked = window.__lateralRanked || [];
  const idx = ranked.indexOf(admin);
  if (idx < 0 || !$("lateral-account")) return;
  $("lateral-account").value = String(idx);
  window.__lateralFocus = null;
  resetLateralView();
  drawLateral(admin);
}

function presencePill(presence) {
  const label = { workstation: "WKS only", server: "Server only", both: "Both" }[presence] || presence;
  return `<span class="pill ${presence}">${label}</span>`;
}

function renderHostTable() {
  const data = window.__hotel;
  const role = window.__filters.role;
  const q = ($("host-filter").value || "").toLowerCase();
  const rows = data.hosts.filter((h) => {
    if (role !== "all" && h.role !== role) return false;
    const blob = `${h.ip} ${h.dns} ${h.netbios} ${h.os}`.toLowerCase();
    return !q || blob.includes(q);
  });
  $("host-count").textContent = `${fmt(rows.length)} shown`;
  $("host-table").innerHTML = `
    <table>
      <thead><tr><th>Host</th><th>Role</th><th>IP</th><th>OS</th><th>Admins</th></tr></thead>
      <tbody>
        ${rows.map((h) => `
          <tr class="host-row" data-idx="${data.hosts.indexOf(h)}">
            <td>
              <div class="mono">${escapeHtml(h.dns || h.netbios || "—")}</div>
              <div class="muted">${escapeHtml(h.netbios || "")}</div>
            </td>
            <td>${rolePill(h.role)}</td>
            <td class="mono">${escapeHtml(h.ip || "—")}</td>
            <td>${escapeHtml(h.os || "—")}</td>
            <td>${h.admin_count}</td>
          </tr>
          <tr class="detail-row" data-for="${data.hosts.indexOf(h)}" hidden>
            <td colspan="5" class="detail">${adminMiniTable(h.admins)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  $("host-table").querySelectorAll(".host-row").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = row.dataset.idx;
      const detail = $("host-table").querySelector(`[data-for="${idx}"]`);
      const open = !detail.hidden;
      $("host-table").querySelectorAll(".detail-row").forEach((d) => (d.hidden = true));
      $("host-table").querySelectorAll(".host-row").forEach((r) => r.classList.remove("selected"));
      if (!open) {
        detail.hidden = false;
        row.classList.add("selected");
      }
    });
  });
}

function adminMiniTable(admins) {
  if (!admins.length) return `<div class="muted">No administrator accounts parsed for this host.</div>`;
  return `<table>
    <thead><tr><th>Account</th><th>Kind</th></tr></thead>
    <tbody>${admins.map((a) => `<tr><td class="mono">${escapeHtml(a.name || "—")}</td><td>${pill(a.kind)}</td></tr>`).join("")}</tbody>
  </table>`;
}

function renderAdminTable() {
  const data = window.__hotel;
  const role = window.__filters.role;
  const q = ($("admin-filter").value || "").toLowerCase();
  const kind = $("kind-filter").value;
  const presence = $("presence-filter").value;
  const rows = data.unique_admins.filter((a) => {
    if (kind && a.kind !== kind) return false;
    if (presence && a.presence !== presence) return false;
    if (role === "workstation" && !a.workstation_count) return false;
    if (role === "server" && !a.server_count) return false;
    const blob = `${a.name} ${a.domain} ${a.account} ${(a.usages || []).map((u) => `${u.host} ${u.sam} ${u.netbios}`).join(" ")}`.toLowerCase();
    return !q || blob.includes(q);
  });
  window.__adminRows = rows;
  $("admin-table").innerHTML = `
    <table>
      <thead><tr><th>Account</th><th>Kind</th><th>Present on</th><th>WKS</th><th>Servers</th></tr></thead>
      <tbody>
        ${rows.slice(0, 400).map((a, i) => `
          <tr class="admin-row" data-i="${i}">
            <td>
              <div class="mono">${escapeHtml(a.grouped ? a.account : a.name)}</div>
              <div class="muted">${a.grouped
                ? `Local account on ${fmt(a.host_count)} host${a.host_count === 1 ? "" : "s"}`
                : `${a.host_count} host${a.host_count === 1 ? "" : "s"}`}</div>
            </td>
            <td>${pill(a.kind)}</td>
            <td>${presencePill(a.presence)}</td>
            <td>${a.workstation_count}</td>
            <td>${a.server_count}</td>
          </tr>
          <tr class="detail-row" data-admin="${i}" hidden>
            <td colspan="5" class="detail"></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ${rows.length > 400 ? `<div class="empty">Showing 400 of ${fmt(rows.length)}. Export CSV for the full list.</div>` : ""}
  `;
  $("admin-table").querySelectorAll(".admin-row").forEach((row) => {
    row.addEventListener("click", () => {
      const i = row.dataset.i;
      const detail = $("admin-table").querySelector(`[data-admin="${i}"]`);
      const open = !detail.hidden;
      $("admin-table").querySelectorAll(".detail-row").forEach((d) => (d.hidden = true));
      $("admin-table").querySelectorAll(".admin-row").forEach((r) => r.classList.remove("selected"));
      if (!open) {
        const admin = window.__adminRows[Number(i)];
        detail.querySelector(".detail").innerHTML = adminHostDetail(admin);
        detail.hidden = false;
        row.classList.add("selected");
        selectLateralAdmin(admin);
      }
    });
  });
}

function adminHostDetail(admin) {
  const usages = admin.usages || [];
  if (usages.length) {
    const wks = usages.filter((u) => u.role === "workstation");
    const srv = usages.filter((u) => u.role === "server");
    const sidNote = admin.sid_count > 1
      ? `<div class="muted">${fmt(admin.sid_count)} distinct SIDs — same name, different local identities.</div>`
      : "";
    return `${sidNote}<div class="split-hosts">
      ${usageColumn("Workstations", wks)}
      ${usageColumn("Servers", srv)}
    </div>`;
  }
  const wks = (admin.workstation_hosts || []).map((h) => `<li class="mono">${escapeHtml(h)}</li>`).join("");
  const srv = (admin.server_hosts || []).map((h) => `<li class="mono">${escapeHtml(h)}</li>`).join("");
  return `<div class="split-hosts">
    <div>
      <div class="mini-label">Workstations (${fmt(admin.workstation_count)})</div>
      ${wks ? `<ul>${wks}</ul>` : `<div class="muted">Not present on workstations.</div>`}
    </div>
    <div>
      <div class="mini-label">Servers (${fmt(admin.server_count)})</div>
      ${srv ? `<ul>${srv}</ul>` : `<div class="muted">Not present on servers.</div>`}
    </div>
  </div>`;
}

function usageColumn(title, rows) {
  if (!rows.length) {
    return `<div><div class="mini-label">${title} (0)</div><div class="muted">Not used here.</div></div>`;
  }
  return `<div>
    <div class="mini-label">${title} (${fmt(rows.length)})</div>
    <table>
      <thead><tr><th>Host</th><th>Account on host</th></tr></thead>
      <tbody>
        ${rows.map((u) => `<tr>
          <td>
            <div class="mono">${escapeHtml(u.host)}</div>
            <div class="muted">${escapeHtml(u.ip || "")}</div>
          </td>
          <td class="mono">${escapeHtml(u.sam)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>`;
}

function exportCsv() {
  const data = window.__hotel;
  const lines = [["hotel", "role", "host_dns", "host_netbios", "ip", "os", "admin_name", "domain", "account", "kind", "sid"]];
  for (const host of data.hosts) {
    for (const admin of host.admins) {
      lines.push([
        data.code,
        host.role,
        host.dns,
        host.netbios,
        host.ip,
        host.os,
        admin.name,
        admin.domain,
        admin.account,
        admin.kind,
        admin.sid,
      ].map(csvCell));
    }
  }
  const blob = new Blob([lines.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `admins-${data.code}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvCell(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadHotel(code) {
  $("status").hidden = true;
  try {
    const data = await api(`/api/hotel/${encodeURIComponent(code.toUpperCase())}`);
    renderHotel(data);
    history.replaceState({}, "", `/?hotel=${data.code}`);
  } catch (err) {
    $("status").hidden = false;
    $("status").textContent = err.message;
  }
}

function renderSuggest(list) {
  const box = $("suggest");
  if (!list.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  state.hotels = list;
  state.active = 0;
  box.hidden = false;
  box.innerHTML = list
    .map(
      (h, i) =>
        `<button type="button" class="${i === 0 ? "active" : ""}" data-code="${h.code}">
          <span class="code">${h.code}</span>
          <span class="meta">${fmt(h.hosts)} hosts</span>
        </button>`
    )
    .join("");
  box.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      loadHotel(btn.dataset.code);
      box.hidden = true;
    });
  });
}

let suggestTimer = 0;
$("hotel-input").addEventListener("input", () => {
  const q = $("hotel-input").value.trim();
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    const data = await api(`/api/hotels?q=${encodeURIComponent(q)}`);
    renderSuggest(data.hotels);
  }, 120);
});

$("hotel-input").addEventListener("keydown", (e) => {
  const box = $("suggest");
  if (box.hidden || !state.hotels.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.active = Math.min(state.active + 1, state.hotels.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.active = Math.max(state.active - 1, 0);
  } else if (e.key === "Escape") {
    box.hidden = true;
    return;
  } else {
    return;
  }
  [...box.children].forEach((el, i) => el.classList.toggle("active", i === state.active));
  [...box.children][state.active]?.scrollIntoView({ block: "nearest" });
});

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("hotel-input").value.trim().toUpperCase();
  $("suggest").hidden = true;
  if (state.hotels[state.active] && !/^[HV][A-Z0-9]{4}$/.test(code)) {
    loadHotel(state.hotels[state.active].code);
    return;
  }
  if (!/^[HV][A-Z0-9]{4}$/.test(code)) {
    $("status").hidden = false;
    $("status").textContent = "Hotel code must start with H or V followed by 4 alphanumeric characters.";
    return;
  }
  loadHotel(code);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) $("suggest").hidden = true;
});

(async function init() {
  try {
    state.summary = await api("/api/summary");
    renderOverview(state.summary);
    const params = new URLSearchParams(location.search);
    const hotel = params.get("hotel");
    if (hotel) loadHotel(hotel);
  } catch (err) {
    $("status").hidden = false;
    $("status").textContent = "Could not load summary: " + err.message;
  }
})();
