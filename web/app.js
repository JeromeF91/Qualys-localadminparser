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
  const bl = summary.bitlocker || {};
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
      <div class="kpi"><div class="label">BitLocker OS off</div><div class="value">${bl.available ? fmt((bl.os_unprotected || 0) + (bl.os_suspended || 0)) : "—"}</div>
        <div class="sub">${bl.available
          ? `${fmt(bl.os_unprotected)} not encrypted${bl.os_suspended ? ` · ${fmt(bl.os_suspended)} protection off` : ""} · ${fmt(bl.os_protected)} protected`
          : "Place an XML whose filename contains bitlocker"}</div></div>
      <div class="kpi"><div class="label">Report generated</div><div class="value" style="font-size:18px;margin-top:10px">${summary.generated.replace("T", " ").replace("Z", " UTC")}</div>
        <div class="sub">${escapeHtml(summary.source || "")}</div></div>
    </div>
    ${summary.stale ? `<p class="status">A newer administrator XML is in the folder: ${escapeHtml(summary.latest_xml)}. Reload to parse it.</p>` : ""}
    ${bl.stale ? `<p class="status">A newer BitLocker XML is in the folder${bl.latest_xml ? `: ${escapeHtml(bl.latest_xml)}` : ""}. Reload to parse it.</p>` : ""}
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
        ${bl.available ? `
          <h2>BitLocker by hotel</h2>
          <div class="body">${
            (bl.hotels || []).length
              ? (bl.hotels || []).map((h) => {
                  const max = Math.max(1, (bl.hotels[0] && bl.hotels[0].hosts) || 1);
                  const pct = Math.max(6, Math.round((h.hosts / max) * 100));
                  const off = (h.os_unprotected || 0) + (h.os_suspended || 0);
                  return `<div class="bar-row clickable" data-code="${h.code}">
                    <div class="name">${h.code}</div>
                    <div class="track"><div class="fill ${off ? "unprotected" : "protected"}" style="width:${pct}%"></div></div>
                    <div class="n wide">${fmt(off)} OS off · ${fmt(h.hosts)}</div>
                  </div>`;
                }).join("")
              : `<div class="empty">BitLocker report loaded, but no hotel codes were found in it.</div>`
          }</div>
        ` : `
          <h2>How to filter</h2>
          <div class="empty">
            Type a hotel code such as <span class="mono">H1401</span> or <span class="mono">V0011</span>.
            Matching is based on DNS, NetBIOS and Qualys asset tags. Click a hotel to drill into workstation vs server statistics and the administrator accounts on each.
            BitLocker review uses a separate Qualys XML whose filename contains <span class="mono">bitlocker</span>.
          </div>
        `}
      </div>
    </div>
  `;
  $("overview").querySelectorAll("[data-code]").forEach((el) => {
    el.addEventListener("click", () => loadHotel(el.dataset.code));
  });
  $("reload-xml").onclick = async () => {
    const status = $("reload-status");
    status.textContent = "Parsing the latest XML files. This can take about 15 seconds…";
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
  window.__filters = { role: "all", kind: "", presence: "", query: "", tagLanpms: true, tagAssets: true };
  window.__blIndex = null;
  window.__scopedAdmins = null;

  const wks = data.roles.workstation;
  const srv = data.roles.server;
  const presence = data.presence_counts || {};
  const tagCounts = tagKindCounts(data.hosts);

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

    <div class="tabs-row">
      <div class="tabs" id="role-tabs">
        <button type="button" class="tab active" data-role="all">All hosts</button>
        <button type="button" class="tab" data-role="workstation">Workstations (${fmt(wks.host_count)})</button>
        <button type="button" class="tab" data-role="server">Servers (${fmt(srv.host_count)})</button>
      </div>
      <div class="tag-filters">
        <span class="muted">Tags</span>
        <label class="tag-check" title="This hotel's Qualys tags ending in LANPMS">
          <input type="checkbox" id="tag-lanpms" checked />
          LANPMS (${fmt(tagCounts.lanpms)})
        </label>
        <label class="tag-check" title="This hotel's Qualys tags ending in Assets">
          <input type="checkbox" id="tag-assets" checked />
          Assets (${fmt(tagCounts.assets)})
        </label>
      </div>
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

    ${bitlockerSection(data.bitlocker)}

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
          <svg id="lateral-graph" viewBox="0 0 1000 680" role="img" aria-label="Lateral movement graph"></svg>
          <div id="lateral-tip" class="graph-tip" hidden></div>
          <div class="graph-legend">
            <span><i class="swatch compromised"></i> Compromised account</span>
            <span><i class="swatch workstation"></i> Workstation</span>
            <span><i class="swatch server"></i> Server</span>
            <span><i class="swatch hop"></i> Extra host via 2nd hop</span>
            <span><i class="swatch hop3"></i> Extra host via 3rd hop</span>
            <span><i class="swatch bl-risk"></i> No BitLocker / protection off</span>
            <span class="muted">Hover a node for the computer name · click a yellow or purple account to list its machines</span>
          </div>
        </div>
        <div class="lateral-side">
          <div class="mini-label">Blast radius</div>
          <div id="lateral-blast" class="lateral-blast"></div>
          <div id="lateral-focus"></div>
          <div class="mini-label">Second hop (local hash reuse)</div>
          <p class="muted hop-note" id="lateral-hop-note"></p>
          <div id="lateral-hops"></div>
          <div class="mini-label">Third hop</div>
          <p class="muted hop-note" id="lateral-third-note"></p>
          <div id="lateral-hops3"></div>
        </div>
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
  $("tag-lanpms").onchange = () => {
    window.__filters.tagLanpms = $("tag-lanpms").checked;
    applyTagScope();
  };
  $("tag-assets").onchange = () => {
    window.__filters.tagAssets = $("tag-assets").checked;
    applyTagScope();
  };
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
  setupBitlocker();
  renderHostTable();
  renderAdminTable();
}

function bitlockerSection(bl) {
  if (!bl || !bl.available) {
    return `<div class="card bitlocker-card">
      <h2>BitLocker</h2>
      <div class="empty">No BitLocker Qualys export loaded. Place an XML whose filename contains <span class="mono">bitlocker</span> next to the administrator export, then reload.</div>
    </div>`;
  }
  if (!bl.host_count) {
    return `<div class="card bitlocker-card">
      <h2>BitLocker</h2>
      <div class="empty">No hosts for this hotel in ${escapeHtml(bl.source || "the BitLocker report")}. OS volume status is the review target; unprotected removable drives are expected.</div>
    </div>`;
  }
  return `
    <div class="card bitlocker-card">
      <h2>BitLocker</h2>
      <p class="bitlocker-note muted">OS volume (usually C:) is the status to review. Unprotected means the disk is not encrypted. Protection off means it is encrypted but BitLocker protectors are disabled (suspended). Unprotected removable drives are listed but not treated as a failure. Source: ${escapeHtml(bl.source || "")}</p>
      <div class="kpis bitlocker-kpis">
        <div class="kpi bl-kpi" data-status="all">
          <div class="label">In report</div>
          <div class="value">${fmt(bl.host_count)}</div>
          <div class="sub">Hosts with QID 45437</div>
        </div>
        <div class="kpi bl-kpi" data-status="protected">
          <div class="label">OS protected</div>
          <div class="value">${fmt(bl.os_protected)}</div>
          <div class="sub">${escapeHtml((bl.encryption_counts && bl.encryption_counts[0] && bl.encryption_counts[0][0]) || "Encryption method varies")}</div>
        </div>
        <div class="kpi bl-kpi" data-status="unprotected">
          <div class="label">OS unprotected</div>
          <div class="value">${fmt(bl.os_unprotected)}</div>
          <div class="sub">Not encrypted</div>
        </div>
        <div class="kpi bl-kpi" data-status="suspended">
          <div class="label">Protection off</div>
          <div class="value">${fmt(bl.os_suspended || 0)}</div>
          <div class="sub">Encrypted, protectors disabled</div>
        </div>
        <div class="kpi bl-kpi" data-status="encrypting">
          <div class="label">In progress</div>
          <div class="value">${fmt((bl.os_encrypting || 0) + (bl.os_decrypting || 0))}</div>
          <div class="sub">${fmt(bl.unprotected_removable_hosts || 0)} with unprotected removable</div>
        </div>
      </div>
      <div class="body pad">${bitlockerMix(bl)}</div>
      <div class="toolbar">
        <div class="tabs" id="bitlocker-tabs">
          <button type="button" class="tab active" data-status="all">All</button>
          <button type="button" class="tab" data-status="unprotected">OS unprotected (${fmt(bl.os_unprotected)})</button>
          <button type="button" class="tab" data-status="suspended">Protection off (${fmt(bl.os_suspended || 0)})</button>
          <button type="button" class="tab" data-status="protected">Protected (${fmt(bl.os_protected)})</button>
          <button type="button" class="tab" data-status="encrypting">In progress (${fmt((bl.os_encrypting || 0) + (bl.os_decrypting || 0))})</button>
          <button type="button" class="tab" data-status="removable">Removable (${fmt(bl.unprotected_removable_hosts || 0)})</button>
        </div>
        <input id="bitlocker-filter" placeholder="Filter computers" />
        <span class="muted" id="bitlocker-count"></span>
      </div>
      <div class="body" id="bitlocker-table"></div>
    </div>
  `;
}

function bitlockerMix(bl) {
  const total = Math.max(1, bl.host_count);
  const rows = [
    ["Protected", bl.os_protected || 0, "protected"],
    ["Unprotected", bl.os_unprotected || 0, "unprotected"],
    ["Protection off", bl.os_suspended || 0, "suspended"],
    ["In progress", (bl.os_encrypting || 0) + (bl.os_decrypting || 0), "encrypting"],
  ];
  const methods = (bl.encryption_counts || [])
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
      <div class="muted mix-foot">${fmt(bl.host_count)} hosts in the BitLocker report</div>
      ${methods}
    </div>
  `;
}

function bitlockerPill(status) {
  const labels = {
    protected: "Protected",
    unprotected: "Unprotected",
    suspended: "Protection off",
    missing: "No BitLocker",
    encrypting: "Encrypting",
    decrypting: "Decrypting",
    unknown: "Unknown",
  };
  return `<span class="pill ${status}">${labels[status] || status}</span>`;
}

function otherVolumeSummary(host) {
  const osLetter = (host.os_letter || "").toUpperCase();
  const extras = (host.volumes || []).filter((v) => (v.letter || "").toUpperCase() !== osLetter);
  if (!extras.length) return `<span class="muted">—</span>`;
  return extras.map((v) => {
    const status = v.status || (v.protection === "1" ? "protected" : "unprotected");
    return `<div>${escapeHtml(v.letter || "?")} ${escapeHtml(v.volume_type_label || "")} · ${bitlockerPill(status)}</div>`;
  }).join("");
}

function setupBitlocker() {
  window.__bitlockerStatus = "all";
  const tabs = $("bitlocker-tabs");
  if (!tabs) return;
  const setStatus = (status) => {
    window.__bitlockerStatus = status;
    tabs.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.status === status);
    });
    $("hotel-view").querySelectorAll(".bl-kpi").forEach((el) => {
      el.classList.toggle("active", el.dataset.status === status);
    });
    renderBitlockerTable();
  };
  tabs.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setStatus(tab.dataset.status));
  });
  $("hotel-view").querySelectorAll(".bl-kpi").forEach((el) => {
    el.addEventListener("click", () => setStatus(el.dataset.status));
  });
  $("bitlocker-filter").oninput = renderBitlockerTable;
  renderBitlockerTable();
}

function renderBitlockerTable() {
  const bl = window.__hotel && window.__hotel.bitlocker;
  const table = $("bitlocker-table");
  if (!bl || !table) return;
  const status = window.__bitlockerStatus || "all";
  const q = (($("bitlocker-filter") && $("bitlocker-filter").value) || "").toLowerCase();
  const rows = (bl.hosts || []).filter((h) => {
    if (status === "unprotected" && h.os_status !== "unprotected") return false;
    if (status === "suspended" && h.os_status !== "suspended") return false;
    if (status === "protected" && h.os_status !== "protected") return false;
    if (status === "encrypting" && h.os_status !== "encrypting" && h.os_status !== "decrypting") return false;
    if (status === "removable" && !h.unprotected_removable) return false;
    const blob = `${h.ip} ${h.dns} ${h.netbios} ${h.os} ${h.os_encryption}`.toLowerCase();
    return !q || blob.includes(q);
  });
  $("bitlocker-count").textContent = `${fmt(rows.length)} shown`;
  if (!rows.length) {
    table.innerHTML = `<div class="empty">No hosts match this BitLocker filter.</div>`;
    return;
  }
  table.innerHTML = `
    <table>
      <thead><tr><th>Computer</th><th>Role</th><th>OS drive</th><th>Status</th><th>Encryption</th><th>Other volumes</th><th>Last found</th></tr></thead>
      <tbody>
        ${rows.map((h) => {
          const idx = bl.hosts.indexOf(h);
          return `
          <tr class="host-row" data-bl-idx="${idx}">
            <td>
              <div class="mono">${escapeHtml(h.dns || h.netbios || "—")}</div>
              <div class="muted">${escapeHtml(h.netbios || h.ip || "")}</div>
            </td>
            <td>${rolePill(h.role)}</td>
            <td class="mono">${escapeHtml(h.os_letter || "—")}</td>
            <td>${bitlockerPill(h.os_status)}</td>
            <td>${escapeHtml(h.os_encryption || "—")}<div class="muted tiny">${escapeHtml(h.os_conversion_label || "")}</div></td>
            <td>${otherVolumeSummary(h)}</td>
            <td class="muted">${escapeHtml(h.last_found || "—")}</td>
          </tr>
          <tr class="detail-row" data-bl-for="${idx}" hidden>
            <td colspan="7" class="detail">${volumeMiniTable(h.volumes)}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
  table.querySelectorAll(".host-row").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = row.dataset.blIdx;
      const detail = table.querySelector(`[data-bl-for="${idx}"]`);
      const open = !detail.hidden;
      table.querySelectorAll(".detail-row").forEach((d) => (d.hidden = true));
      table.querySelectorAll(".host-row").forEach((r) => r.classList.remove("selected"));
      if (!open) {
        detail.hidden = false;
        row.classList.add("selected");
      }
    });
  });
}

function volumeMiniTable(volumes) {
  if (!volumes || !volumes.length) return `<div class="muted">No volume rows in the Qualys result.</div>`;
  return `<table>
    <thead><tr><th>Drive</th><th>Type</th><th>Protection</th><th>Conversion</th><th>Encryption</th><th>Volume ID</th></tr></thead>
    <tbody>${volumes.map((v) => `
      <tr>
        <td class="mono">${escapeHtml(v.letter || "—")}</td>
        <td>${escapeHtml(v.volume_type_label || "—")}</td>
        <td>${bitlockerPill(v.status || (v.protection === "1" ? "protected" : v.protection === "0" ? "unprotected" : "unknown"))}</td>
        <td>${escapeHtml(v.conversion_label || "—")}</td>
        <td>${escapeHtml(v.encryption_label || "—")}</td>
        <td class="mono muted">${escapeHtml(v.volume_id || "—")}</td>
      </tr>`).join("")}</tbody>
  </table>`;
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
  const select = $("lateral-account");
  if (!select) return;
  $("lateral-zoom-in").onclick = () => zoomLateral(1.25);
  $("lateral-zoom-out").onclick = () => zoomLateral(1 / 1.25);
  $("lateral-zoom-reset").onclick = () => {
    resetLateralView();
    applyLateralView();
  };
  const toggle = $("lateral-exclude-rotating");
  toggle.checked = excludeRotatingLocals();
  toggle.onchange = () => {
    setExcludeRotatingLocals(toggle.checked);
    window.__lateralFocus = null;
    const ranked = window.__lateralRanked || [];
    drawLateral(ranked[Number($("lateral-account").value)] || ranked[0]);
  };
  bindLateralNav($("lateral-graph"));
  refreshLateral();
}

function refreshLateral() {
  const select = $("lateral-account");
  if (!select) return;
  const previous = window.__lateralAdmin;
  const ranked = [...scopedUniqueAdmins()].sort((a, b) => {
    if (a.kind === "local" && b.kind !== "local") return -1;
    if (b.kind === "local" && a.kind !== "local") return 1;
    const riskA = aggravatingCount(a.hosts);
    const riskB = aggravatingCount(b.hosts);
    if (riskB !== riskA) return riskB - riskA;
    return b.host_count - a.host_count;
  });
  window.__lateralRanked = ranked;
  window.__lateralFocus = null;
  resetLateralView();
  select.innerHTML = ranked
    .map((a, i) => {
      const risk = aggravatingCount(a.hosts);
      const riskNote = risk ? ` · ${risk} no BitLocker` : "";
      const label = `${adminDisplayName(a)} · ${a.kind} · ${a.host_count} host${a.host_count === 1 ? "" : "s"}${riskNote}`;
      return `<option value="${i}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const next = (previous && ranked.find((a) => adminKey(a) === adminKey(previous))) || ranked[0];
  const idx = Math.max(0, ranked.indexOf(next));
  select.value = String(idx);
  select.onchange = () => {
    window.__lateralFocus = null;
    resetLateralView();
    drawLateral(ranked[Number(select.value)]);
  };
  drawLateral(next);
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

function bitlockerIndex() {
  if (window.__blIndex) return window.__blIndex;
  const byIp = new Map();
  const byDns = new Map();
  const byNb = new Map();
  const hosts = ((window.__hotel && window.__hotel.bitlocker) || {}).hosts || [];
  for (const row of hosts) {
    if (row.ip) byIp.set(row.ip, row);
    if (row.dns) byDns.set(row.dns.toLowerCase(), row);
    if (row.netbios) byNb.set(row.netbios.toLowerCase(), row);
  }
  window.__blIndex = { byIp, byDns, byNb };
  return window.__blIndex;
}

function bitlockerRisk(label) {
  const bl = window.__hotel && window.__hotel.bitlocker;
  if (!bl || !bl.available) {
    return { status: "unknown", aggravating: false, label: "No report" };
  }
  const host = hostByLabel(label) || {};
  const idx = bitlockerIndex();
  const row = (host.ip && idx.byIp.get(host.ip))
    || (host.dns && idx.byDns.get(host.dns.toLowerCase()))
    || (host.netbios && idx.byNb.get(String(host.netbios).toLowerCase()))
    || (label && idx.byDns.get(String(label).toLowerCase()))
    || (label && idx.byNb.get(String(label).toLowerCase()));
  if (row) {
    const aggravating = row.os_status !== "protected";
    const labels = {
      unprotected: "Not encrypted",
      suspended: "Protection off",
      encrypting: "Encrypting",
      decrypting: "Decrypting",
      protected: "Protected",
      unknown: "Unknown",
    };
    return { status: row.os_status, aggravating, label: labels[row.os_status] || row.os_status, row };
  }
  return { status: "missing", aggravating: true, label: "No BitLocker" };
}

function aggravatingCount(labels) {
  return (labels || []).reduce((n, label) => n + (bitlockerRisk(label).aggravating ? 1 : 0), 0);
}

function bitlockerRiskCounts(labels) {
  const counts = {
    total: (labels || []).length,
    aggravating: 0,
    unprotected: 0,
    suspended: 0,
    missing: 0,
    protected: 0,
  };
  for (const label of labels || []) {
    const risk = bitlockerRisk(label);
    if (risk.status === "unprotected") counts.unprotected += 1;
    else if (risk.status === "suspended") counts.suspended += 1;
    else if (risk.status === "missing") counts.missing += 1;
    else if (risk.status === "protected") counts.protected += 1;
    if (risk.aggravating) counts.aggravating += 1;
  }
  return counts;
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

function outerLabel(x, y, ox, oy, nodeR) {
  const dx = x - ox;
  const dy = y - oy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { lx: x, ly: y + nodeR + 16 };
  const dist = len + nodeR + 14;
  return { lx: ox + (dx / len) * dist, ly: oy + (dy / len) * dist };
}

function shortLabel(text, max = 22) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function dumpableLocals(except) {
  const skipRotating = excludeRotatingLocals();
  const exceptKey = adminKey(except);
  return scopedUniqueAdmins().filter((a) => {
    if (exceptKey && adminKey(a) === exceptKey) return false;
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
  return expandHops(direct, direct, compromised, 2);
}

function thirdHops(compromised, hop2) {
  const hop2Hosts = new Set();
  hop2.forEach((h) => h.extra.forEach((x) => hop2Hosts.add(x)));
  const already = new Set(compromised.hosts || []);
  hop2Hosts.forEach((h) => already.add(h));
  return expandHops(hop2Hosts, already, compromised, 3);
}

function expandHops(fromHosts, alreadyReached, compromised, depth) {
  const hops = [];
  for (const other of dumpableLocals(compromised)) {
    const origin = (other.hosts || []).filter((h) => fromHosts.has(h));
    if (!origin.length) continue;
    const extra = (other.hosts || []).filter((h) => !alreadyReached.has(h));
    if (!extra.length) continue;
    hops.push({ admin: other, extra, origin, depth, blRisk: aggravatingCount(extra) });
  }
  hops.sort((a, b) => {
    if ((b.blRisk || 0) !== (a.blRisk || 0)) return (b.blRisk || 0) - (a.blRisk || 0);
    return b.extra.length - a.extra.length;
  });
  return hops;
}

function findHop(account, hops, third) {
  return (hops || []).find((h) => h.admin.account === account)
    || (third || []).find((h) => h.admin.account === account);
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
    const risk = bitlockerRisk(node.dataset.host);
    html = `
      <div class="mono strong">${escapeHtml(meta.name)}</div>
      ${meta.dns ? `<div class="muted">${escapeHtml(meta.dns)}</div>` : ""}
      <div>${meta.role === "server" ? "Server" : "Workstation"}${meta.ip ? ` · ${escapeHtml(meta.ip)}` : ""}</div>
      <div class="muted">${account
        ? `Also has local account ${escapeHtml(account)}`
        : `Has ${escapeHtml(adminDisplayName(window.__lateralAdmin))} as local admin`}</div>
      <div>${risk.aggravating ? "Aggravating · " : ""}${escapeHtml(risk.label)}</div>
    `;
  } else if (kind === "hop-account" || kind === "hop-cluster" || kind === "hop3-account") {
    const hopAdmin = (scopedUniqueAdmins() || []).find(
      (a) => a.kind === "local" && a.account === node.dataset.account
    );
    const hosts = (hopAdmin && hopAdmin.hosts) || [];
    const depth = kind === "hop3-account" ? "3rd" : "2nd";
    const risk = aggravatingCount(hosts);
    html = `
      <div class="mono strong">${escapeHtml(node.dataset.account)}</div>
      <div>${depth} hop · local account on ${fmt(hosts.length)} computer${hosts.length === 1 ? "" : "s"}</div>
      ${risk ? `<div>Aggravating · ${fmt(risk)} lack BitLocker protection</div>` : ""}
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
  if (kind === "hop-account" || kind === "hop-cluster" || kind === "hop3-account") {
    window.__lateralFocus = {
      type: "hop",
      account: dataset.account,
      depth: kind === "hop3-account" ? 3 : 2,
    };
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

function renderFocusPanel(admin, hops, third, hiddenWks) {
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
    const hop = findHop(focus.account, hops, third);
    if (!hop) {
      box.innerHTML = "";
      return;
    }
    const depth = hop.depth === 3 ? "Third hop" : "Second hop";
    const fromLabel = hop.depth === 3
      ? "Dumped from (reached at hop 2)"
      : "Dumped from (already reached)";
    box.innerHTML = `
      <div class="mini-label">${depth} · this account is on</div>
      <div class="focus-head mono">${escapeHtml(hop.admin.account)}</div>
      <p class="muted hop-note">${hop.depth === 3
        ? "Dump this local on a computer reached at hop 2, then reuse the same name where it already exists."
        : "Same local name on the machines below. Dump it from a reached host, then reuse it where it already exists."}</p>
      <div class="mini-label">${fromLabel}</div>
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
      <div class="muted">${escapeHtml(bitlockerRisk(focus.label).label)}</div>
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
  const showBl = Boolean(window.__hotel && window.__hotel.bitlocker && window.__hotel.bitlocker.available);
  const rows = (items || []).map((item) => {
    if (typeof item === "string") return { meta: hostMeta(item), via: [], risk: bitlockerRisk(item) };
    return { meta: hostMeta(item.label), via: item.via || [], risk: bitlockerRisk(item.label) };
  }).sort((a, b) => {
    if (a.risk.aggravating !== b.risk.aggravating) return a.risk.aggravating ? -1 : 1;
    if (a.meta.role !== b.meta.role) return a.meta.role === "server" ? -1 : 1;
    return a.meta.name.localeCompare(b.meta.name, undefined, { sensitivity: "base" });
  });
  if (!rows.length) return `<div class="muted">No computers.</div>`;
  const showVia = rows.some((r) => r.via.length);
  return `<table class="presence-table">
    <thead><tr><th>Computer</th><th>Role</th><th>IP</th>${showBl ? "<th>BitLocker</th>" : ""}${showVia ? "<th>Via</th>" : ""}</tr></thead>
    <tbody>
      ${rows.map((row) => `
        <tr class="hop-row presence-row${row.risk.aggravating ? " bl-risk-row" : ""}" data-host="${escapeHtml(row.meta.label)}">
          <td>
            <div class="mono">${escapeHtml(row.meta.name)}</div>
            ${row.meta.dns && row.meta.dns.toLowerCase() !== row.meta.name.toLowerCase()
              ? `<div class="muted tiny">${escapeHtml(row.meta.dns)}</div>` : ""}
          </td>
          <td>${rolePill(row.meta.role)}</td>
          <td class="mono muted">${escapeHtml(row.meta.ip || "—")}</td>
          ${showBl ? `<td>${bitlockerPill(row.risk.status)}</td>` : ""}
          ${showVia ? `<td class="muted">${row.via.length ? escapeHtml(row.via.map((a) => a.account).join(", ")) : "—"}</td>` : ""}
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}

function hopTableHtml(hops, focus, depth) {
  if (!hops.length) return "";
  return `<table>
      <thead><tr><th>Local account</th><th>Extra hosts</th></tr></thead>
      <tbody>
        ${hops.slice(0, 12).map((h) => `
          <tr class="hop-row${focus && focus.type === "hop" && focus.account === h.admin.account ? " selected" : ""}" data-account="${escapeHtml(h.admin.account)}" data-depth="${depth}">
            <td class="mono">${escapeHtml(h.admin.account)}</td>
            <td>${fmt(h.extra.length)}${h.blRisk ? `<div class="muted tiny">${fmt(h.blRisk)} no BitLocker</div>` : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ${hops.length > 12 ? `<div class="muted">Showing 12 of ${fmt(hops.length)} dump-and-reuse paths.</div>` : ""}`;
}

function drawLateral(admin) {
  if (!admin) return;
  window.__lateralAdmin = admin;
  const data = window.__hotel;
  const hops = secondHops(admin);
  const third = thirdHops(admin, hops);
  const directHosts = (admin.hosts || []).map(hostMeta);
  const servers = directHosts.filter((h) => h.role === "server");
  const workstations = directHosts.filter((h) => h.role !== "server");
  const extraHostSet = new Set();
  hops.forEach((h) => h.extra.forEach((x) => extraHostSet.add(x)));
  const hop3HostSet = new Set();
  third.forEach((h) => h.extra.forEach((x) => hop3HostSet.add(x)));
  const extraCount = extraHostSet.size;
  const hop3Count = hop3HostSet.size;
  const totalReached = extraCount + hop3Count + directHosts.length;
  const siteCount = scopedHosts().length || data.host_count;
  const pct = siteCount ? Math.round((totalReached / siteCount) * 100) : 0;
  const focus = window.__lateralFocus;
  const reachedLabels = [
    ...(admin.hosts || []),
    ...extraHostSet,
    ...hop3HostSet,
  ];
  const blCounts = bitlockerRiskCounts(reachedLabels);
  const showBl = Boolean(data.bitlocker && data.bitlocker.available);

  $("lateral-summary").textContent = `${fmt(directHosts.length)} direct · +${fmt(extraCount)} hop 2 · +${fmt(hop3Count)} hop 3 (${pct}% of site)${tagFilterLabel()}${showBl && blCounts.aggravating ? ` · ${fmt(blCounts.aggravating)} no BitLocker` : ""}`;
  $("lateral-hop-note").textContent = excludeRotatingLocals()
    ? "Dump SAM/LSA on a reached host, then reuse other local names that appear elsewhere. Administrator, AdminDevice, and AdminIT are excluded — they use unique rotating passwords."
    : "Dump SAM/LSA on a reached host, then reuse other local names that appear elsewhere. Assumes the same local name reuses a password or hash.";
  $("lateral-third-note").textContent = third.length
    ? "From computers reached at hop 2, dump other local accounts and reuse them on machines not yet reached."
    : "No further hosts. Locals on hop-2 machines are not reused outside the computers already reached.";
  $("lateral-blast").innerHTML = `
    <div class="blast-line"><strong>${fmt(directHosts.length)}</strong> hosts with this account as local admin</div>
    <div class="blast-line">${fmt(workstations.length)} workstations · ${fmt(servers.length)} servers</div>
    <div class="blast-line">${fmt(extraCount)} additional host${extraCount === 1 ? "" : "s"} at hop 2 (dump and reuse)</div>
    <div class="blast-line">${fmt(hop3Count)} additional host${hop3Count === 1 ? "" : "s"} at hop 3</div>
    ${showBl ? `<div class="blast-line${blCounts.aggravating ? " aggravating" : ""}"><strong>${fmt(blCounts.aggravating)}</strong> of ${fmt(blCounts.total)} reached host${blCounts.total === 1 ? "" : "s"} lack BitLocker protection</div>
    <div class="blast-line muted">${fmt(blCounts.unprotected)} not encrypted · ${fmt(blCounts.suspended)} protection off · ${fmt(blCounts.missing)} not in report</div>` : ""}
  `;
  $("lateral-hops").innerHTML = hops.length
    ? hopTableHtml(hops, focus, 2)
    : `<div class="muted">No extra hosts at hop 2.</div>`;
  $("lateral-hops3").innerHTML = hopTableHtml(third, focus, 3);

  const svg = $("lateral-graph");
  const cx = 500;
  const cy = 340;
  const maxWks = 22;
  const shownWks = workstations.slice(0, maxWks);
  const hiddenWks = workstations.slice(maxWks);
  const extraShown = hops.slice(0, 6);
  const thirdShown = third.slice(0, 5);
  const maxFocusExtra = 8;

  const lit = new Set();
  let hostExtras = [];
  if (focus && focus.type === "hop") {
    const hop = findHop(focus.account, hops, third);
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
    const [x, y] = polar(cx, cy, 370, i, extraShown.length);
    const hopLit = !dimmed || lit.has(`account:${hop.admin.account}`);
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge hop${hopLit ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 14, cls: "hop-account",
      kind: "hop-account",
      key: `account:${hop.admin.account}`,
      account: hop.admin.account,
      label: shortLabel(hop.admin.account, 18),
      sub: `+${hop.extra.length} extra${hop.blRisk ? ` · ${hop.blRisk} no BL` : ""}`,
      title: `${hop.admin.account} · 2nd hop · ${hop.extra.length} extra computer(s)${hop.blRisk ? ` · ${hop.blRisk} lack BitLocker` : ""}`,
      ...outerLabel(x, y, cx, cy, 14),
    });
  });

  thirdShown.forEach((hop, i) => {
    const [x, y] = polar(cx, cy, 470, i, thirdShown.length);
    const hopLit = !dimmed || lit.has(`account:${hop.admin.account}`);
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge hop3${hopLit ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 14, cls: "hop3-account",
      kind: "hop3-account",
      key: `account:${hop.admin.account}`,
      account: hop.admin.account,
      label: shortLabel(hop.admin.account, 18),
      sub: `+${hop.extra.length} extra${hop.blRisk ? ` · ${hop.blRisk} no BL` : ""}`,
      title: `${hop.admin.account} · 3rd hop · ${hop.extra.length} extra computer(s)${hop.blRisk ? ` · ${hop.blRisk} lack BitLocker` : ""}`,
      ...outerLabel(x, y, cx, cy, 14),
    });
  });

  if (focus && focus.type === "hop") {
    const hop = findHop(focus.account, hops, third);
    const hopNode = nodes.find((n) => n.account === focus.account && (n.kind === "hop-account" || n.kind === "hop3-account"));
    if (hop && hopNode) {
      const shownExtra = hop.extra.slice(0, maxFocusExtra);
      const hiddenExtra = hop.extra.length - shownExtra.length;
      shownExtra.forEach((label, j) => {
        if (nodes.some((n) => n.host === label)) return;
        const meta = hostMeta(label);
        const [ex, ey] = outwardPolar(hopNode.x, hopNode.y, cx, cy, 92, j, shownExtra.length + (hiddenExtra ? 1 : 0));
        const edgeCls = hop.depth === 3 ? "hop3" : "hop";
        lines.push(`<line x1="${hopNode.x}" y1="${hopNode.y}" x2="${ex}" y2="${ey}" class="edge ${edgeCls} active" />`);
        nodes.push({
          x: ex, y: ey, r: 11,
          cls: hop.depth === 3
            ? (meta.role === "server" ? "hop3-host server" : "hop3-host")
            : (meta.role === "server" ? "hop-host server" : "hop-host"),
          kind: "hop-host",
          key: `host:${label}`,
          host: label,
          account: hop.admin.account,
          label: meta.short,
          title: `${meta.name}\n${label}\n${meta.ip}\n${meta.role}\nreached at hop ${hop.depth}`,
          ...outerLabel(ex, ey, hopNode.x, hopNode.y, 11),
        });
      });
      if (hiddenExtra) {
        const [ex, ey] = outwardPolar(hopNode.x, hopNode.y, cx, cy, 92, shownExtra.length, shownExtra.length + 1);
        nodes.push({
          x: ex, y: ey, r: 16,
          cls: hop.depth === 3 ? "hop3-host" : "hop-host",
          kind: "hop-cluster",
          key: `account:${hop.admin.account}`,
          account: hop.admin.account,
          label: `+${hiddenExtra} more`,
          title: hop.extra.slice(maxFocusExtra).map((h) => hostMeta(h).name).join("\n"),
          ...outerLabel(ex, ey, hopNode.x, hopNode.y, 16),
        });
      }
    }
  }

  servers.forEach((h, i) => {
    const [x, y] = polar(cx, cy, 140, i, Math.max(servers.length, 1));
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge${!dimmed || lit.has(`host:${h.label}`) ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 14, cls: "server",
      kind: "host",
      key: `host:${h.label}`,
      host: h.label,
      label: h.short,
      title: `${h.name}\n${h.dns || h.label}\n${h.ip}\nserver`,
      ...outerLabel(x, y, cx, cy, 14),
    });
  });

  shownWks.forEach((h, i) => {
    const [x, y] = polar(cx, cy, 255, i, shownWks.length + (hiddenWks.length ? 1 : 0));
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge${!dimmed || lit.has(`host:${h.label}`) ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 11, cls: "workstation",
      kind: "host",
      key: `host:${h.label}`,
      host: h.label,
      label: h.short,
      title: `${h.name}\n${h.dns || h.label}\n${h.ip}\nworkstation`,
      ...outerLabel(x, y, cx, cy, 11),
    });
  });
  if (hiddenWks.length) {
    const [x, y] = polar(cx, cy, 255, shownWks.length, shownWks.length + 1);
    lines.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge${!dimmed || lit.has("wks-cluster") ? "" : " dim"}" />`);
    nodes.push({
      x, y, r: 18, cls: "workstation cluster",
      kind: "wks-cluster",
      key: "wks-cluster",
      label: `+${hiddenWks.length} WKS`,
      title: `${hiddenWks.length} more workstations`,
      ...outerLabel(x, y, cx, cy, 18),
    });
  }

  if (focus && focus.type === "hop") {
    const hopNode = nodes.find((n) => n.account === focus.account && (n.kind === "hop-account" || n.kind === "hop3-account"));
    const hop = findHop(focus.account, hops, third);
    if (hopNode && hop) {
      const edgeCls = hop.depth === 3 ? "hop3" : "hop";
      hop.origin.forEach((label) => {
        const origin = nodes.find((n) => n.host === label);
        if (!origin) return;
        lines.push(`<line x1="${origin.x}" y1="${origin.y}" x2="${hopNode.x}" y2="${hopNode.y}" class="edge ${edgeCls} active" />`);
      });
      hop.extra.forEach((label) => {
        const extra = nodes.find((n) => n.host === label);
        if (!extra) return;
        lines.push(`<line x1="${hopNode.x}" y1="${hopNode.y}" x2="${extra.x}" y2="${extra.y}" class="edge ${edgeCls} active" />`);
      });
    }
  }

  if (focus && focus.type === "host") {
    const origin = nodes.find((n) => n.host === focus.label && n.kind === "host")
      || nodes.find((n) => n.host === focus.label);
    const ox = origin ? origin.x : cx;
    const oy = origin ? origin.y : cy;
    const extrasToPlace = hostExtras.filter((row) => !nodes.some((n) => n.host === row.label));
    extrasToPlace.slice(0, maxFocusExtra).forEach((row, j) => {
      const meta = hostMeta(row.label);
      const [ex, ey] = polar(ox, oy, 88, j, Math.min(extrasToPlace.length, maxFocusExtra));
      nodes.push({
        x: ex, y: ey, r: 11,
        cls: meta.role === "server" ? "hop-host server" : "hop-host",
        kind: "hop-host",
        key: `host:${row.label}`,
        host: row.label,
        label: meta.short,
        title: `${meta.name}\n${row.label}\n${meta.ip}\nvia ${(row.via || []).map((a) => a.account).join(", ")}`,
        ...outerLabel(ex, ey, ox, oy, 11),
      });
    });
    hostExtras.forEach((row) => {
      const target = nodes.find((n) => n.host === row.label);
      if (!target) return;
      lines.push(`<line x1="${ox}" y1="${oy}" x2="${target.x}" y2="${target.y}" class="edge hop active" />`);
    });
  }

  nodes.push({
    x: cx, y: cy, r: 32, cls: "compromised",
    kind: "compromised",
    key: "compromised",
    label: shortLabel(adminDisplayName(admin), 18),
    title: `${adminDisplayName(admin)}\n${admin.kind}\n${admin.host_count} hosts`,
    lx: cx,
    ly: cy + 50,
  });

  nodes.forEach((n) => {
    if (!n.host) return;
    const risk = bitlockerRisk(n.host);
    if (risk.aggravating) n.cls = `${n.cls || ""} bl-risk`.trim();
    n.title = `${n.title || ""}\nBitLocker: ${risk.label}`;
  });

  svg.innerHTML = `
    <defs>
      <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <rect class="graph-bg" width="1000" height="680" fill="#121820" />
    <g class="lateral-scene">
      <circle cx="${cx}" cy="${cy}" r="140" class="ring" />
      <circle cx="${cx}" cy="${cy}" r="255" class="ring" />
      <circle cx="${cx}" cy="${cy}" r="370" class="ring" />
      <circle cx="${cx}" cy="${cy}" r="470" class="ring" />
      ${lines.join("")}
      ${nodes.map((n) => {
        const isLit = !dimmed || n.kind === "compromised" || lit.has(n.key);
        const focused = (focus && focus.type === "host" && n.host === focus.label)
          || (focus && focus.type === "hop" && n.account === focus.account && n.kind !== "hop-host");
        return `
      <g class="g-node${isLit ? "" : " dim"}${focused ? " focused" : ""}" data-kind="${escapeHtml(n.kind || "")}" data-host="${escapeHtml(n.host || "")}" data-account="${escapeHtml(n.account || "")}">
        <title>${escapeHtml(n.title)}</title>
        <circle cx="${n.x}" cy="${n.y}" r="${n.r + 12}" class="hit" />
        <circle cx="${n.x}" cy="${n.y}" r="${n.r}" class="node ${n.cls}"${focused ? ` filter="url(#node-glow)"` : ""} />
        <text x="${n.lx}" y="${n.ly}" class="node-label">
          <tspan x="${n.lx}" dy="0">${escapeHtml(n.label)}</tspan>
          ${n.sub ? `<tspan x="${n.lx}" dy="13" class="node-sub${n.kind === "hop3-account" ? " hop3" : ""}">${escapeHtml(n.sub)}</tspan>` : ""}
        </text>
      </g>`;
      }).join("")}
    </g>
  `;

  applyLateralView();
  renderFocusPanel(admin, hops, third, hiddenWks);
  const onHopRow = (row) => {
    window.__lateralFocus = {
      type: "hop",
      account: row.dataset.account,
      depth: Number(row.dataset.depth) || 2,
    };
    drawLateral(admin);
  };
  $("lateral-hops").querySelectorAll(".hop-row").forEach((row) => row.addEventListener("click", () => onHopRow(row)));
  $("lateral-hops3").querySelectorAll(".hop-row").forEach((row) => row.addEventListener("click", () => onHopRow(row)));
  $("lateral-focus").querySelectorAll(".presence-row").forEach((row) => {
    row.addEventListener("click", () => {
      window.__lateralFocus = { type: "host", label: row.dataset.host };
      drawLateral(admin);
    });
  });
}

function selectLateralAdmin(admin) {
  const ranked = window.__lateralRanked || [];
  const idx = ranked.findIndex((a) => adminKey(a) === adminKey(admin));
  if (idx < 0 || !$("lateral-account")) return;
  $("lateral-account").value = String(idx);
  window.__lateralFocus = null;
  resetLateralView();
  drawLateral(ranked[idx]);
}

function presencePill(presence) {
  const label = { workstation: "WKS only", server: "Server only", both: "Both" }[presence] || presence;
  return `<span class="pill ${presence}">${label}</span>`;
}

function tagKindCounts(hosts) {
  const counts = { lanpms: 0, assets: 0 };
  for (const host of hosts || []) {
    const kinds = host.tag_kinds || [];
    if (kinds.includes("lanpms")) counts.lanpms += 1;
    if (kinds.includes("assets")) counts.assets += 1;
  }
  return counts;
}

function tagKindPills(kinds) {
  if (!kinds || !kinds.length) return `<span class="muted">—</span>`;
  return kinds.map((kind) => (
    kind === "lanpms"
      ? `<span class="pill lanpms">LANPMS</span>`
      : `<span class="pill assets">Assets</span>`
  )).join(" ");
}

function hostMatchesTagFilter(host) {
  const wantLan = window.__filters.tagLanpms !== false;
  const wantAssets = window.__filters.tagAssets !== false;
  if (wantLan && wantAssets) return true;
  if (!wantLan && !wantAssets) return false;
  const kinds = host.tag_kinds || [];
  if (wantLan) return kinds.includes("lanpms");
  return kinds.includes("assets");
}

function hostLabel(host) {
  return host.dns || host.netbios || host.ip;
}

function adminKey(admin) {
  if (!admin) return "";
  return `${admin.kind || ""}|${String(admin.domain || "").toLowerCase()}|${String(admin.account || "").toLowerCase()}`;
}

function tagFilterActive() {
  const lan = window.__filters.tagLanpms !== false;
  const assets = window.__filters.tagAssets !== false;
  return !(lan && assets);
}

function tagFilterLabel() {
  const lan = window.__filters.tagLanpms !== false;
  const assets = window.__filters.tagAssets !== false;
  if (lan && assets) return "";
  if (lan) return " · LANPMS";
  if (assets) return " · Assets";
  return " · no tags";
}

function scopedHosts() {
  return ((window.__hotel && window.__hotel.hosts) || []).filter(hostMatchesTagFilter);
}

function scopedUniqueAdmins() {
  if (window.__scopedAdmins) return window.__scopedAdmins;
  const data = window.__hotel;
  if (!data) return [];
  if (!tagFilterActive()) {
    window.__scopedAdmins = data.unique_admins || [];
    return window.__scopedAdmins;
  }
  const allowed = new Set(scopedHosts().map(hostLabel));
  window.__scopedAdmins = (data.unique_admins || []).map((admin) => {
    const hosts = (admin.hosts || []).filter((label) => allowed.has(label));
    if (!hosts.length) return null;
    const wks = (admin.workstation_hosts || []).filter((label) => allowed.has(label));
    const srv = (admin.server_hosts || []).filter((label) => allowed.has(label));
    const usages = (admin.usages || []).filter((u) => allowed.has(u.host));
    let presence = "server";
    if (wks.length && srv.length) presence = "both";
    else if (wks.length) presence = "workstation";
    return {
      ...admin,
      hosts,
      host_count: hosts.length,
      workstation_hosts: wks,
      workstation_count: wks.length,
      server_hosts: srv,
      server_count: srv.length,
      usages,
      presence,
    };
  }).filter(Boolean);
  return window.__scopedAdmins;
}

function applyTagScope() {
  window.__scopedAdmins = null;
  renderHostTable();
  renderAdminTable();
  refreshLateral();
}

function renderHostTable() {
  const data = window.__hotel;
  const role = window.__filters.role;
  const q = ($("host-filter").value || "").toLowerCase();
  const rows = data.hosts.filter((h) => {
    if (role !== "all" && h.role !== role) return false;
    if (!hostMatchesTagFilter(h)) return false;
    const blob = `${h.ip} ${h.dns} ${h.netbios} ${h.os}`.toLowerCase();
    return !q || blob.includes(q);
  });
  $("host-count").textContent = `${fmt(rows.length)} shown`;
  $("host-table").innerHTML = `
    <table>
      <thead><tr><th>Host</th><th>Role</th><th>Tags</th><th>IP</th><th>OS</th><th>Admins</th></tr></thead>
      <tbody>
        ${rows.map((h) => `
          <tr class="host-row" data-idx="${data.hosts.indexOf(h)}">
            <td>
              <div class="mono">${escapeHtml(h.dns || h.netbios || "—")}</div>
              <div class="muted">${escapeHtml(h.netbios || "")}</div>
            </td>
            <td>${rolePill(h.role)}</td>
            <td>${tagKindPills(h.tag_kinds)}</td>
            <td class="mono">${escapeHtml(h.ip || "—")}</td>
            <td>${escapeHtml(h.os || "—")}</td>
            <td>${h.admin_count}</td>
          </tr>
          <tr class="detail-row" data-for="${data.hosts.indexOf(h)}" hidden>
            <td colspan="6" class="detail">${adminMiniTable(h.admins)}</td>
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
  const rows = scopedUniqueAdmins().filter((a) => {
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
