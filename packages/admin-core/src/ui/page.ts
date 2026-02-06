type PageConfig = {
  corePublicUrl: string;
};

export function renderAdminPage(config: PageConfig): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Durable Streams Admin</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-page:#0a0a0f;--bg-card:#12121a;--bg-elevated:#1a1a26;--bg-hover:#242432;
  --border:#2a2a3a;
  --text:#f0f0f5;--text-secondary:#a0a0b5;--text-muted:#606075;
  --blue:#5b8df8;--green:#34d399;--amber:#fbbf24;--red:#f87171;--purple:#a78bfa;--cyan:#22d3ee;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-mono:"SF Mono","Fira Code","Fira Mono",Menlo,monospace;
}
html{font-size:14px}
body{background:var(--bg-page);color:var(--text);font-family:var(--font-sans);line-height:1.5;min-height:100vh}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}

/* Layout */
.header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px}
.header h1{font-size:1.15rem;font-weight:600;letter-spacing:-0.02em}
.header .dot{width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block}
.tabs{display:flex;gap:0;border-bottom:1px solid var(--border);padding:0 24px}
.tab{padding:10px 20px;cursor:pointer;color:var(--text-secondary);border-bottom:2px solid transparent;transition:all 0.15s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--blue);border-bottom-color:var(--blue)}
.content{padding:24px;max-width:1400px;margin:0 auto}
.panel{display:none}
.panel.active{display:block}

/* Cards */
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.stat-card{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px 20px}
.stat-card .label{font-size:0.8rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px}
.stat-card .value{font-size:1.8rem;font-weight:700;font-family:var(--font-mono);line-height:1.2}
.stat-card .sparkline{margin-top:8px}
.stat-card .value.blue{color:var(--blue)}
.stat-card .value.green{color:var(--green)}
.stat-card .value.amber{color:var(--amber)}
.stat-card .value.cyan{color:var(--cyan)}

/* Tables */
.table-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:24px}
.table-wrap h3{padding:12px 16px;font-size:0.85rem;color:var(--text-secondary);border-bottom:1px solid var(--border);font-weight:500}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 16px;font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border);font-weight:500}
td{padding:8px 16px;font-size:0.85rem;font-family:var(--font-mono);border-bottom:1px solid var(--border);color:var(--text-secondary)}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg-hover)}
td.clickable{color:var(--blue);cursor:pointer}
td.clickable:hover{text-decoration:underline}

/* Chart */
.chart-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:24px}
.chart-wrap h3{font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px;font-weight:500}
.chart-wrap svg{width:100%;height:180px}

/* Inspect */
.search-bar{display:flex;gap:12px;margin-bottom:24px}
.search-bar input{flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px 14px;color:var(--text);font-family:var(--font-mono);font-size:0.9rem;outline:none}
.search-bar input:focus{border-color:var(--blue)}
.search-bar button{background:var(--blue);color:#fff;border:none;border-radius:6px;padding:10px 20px;cursor:pointer;font-weight:500}
.search-bar button:hover{opacity:0.9}

.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.meta-item{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:12px 16px}
.meta-item .label{font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px}
.meta-item .val{font-family:var(--font-mono);font-size:0.9rem}

.realtime-row{display:flex;gap:16px;margin-bottom:24px}
.rt-badge{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:12px 20px;display:flex;align-items:center;gap:10px}
.rt-badge .dot{width:8px;height:8px;border-radius:50%;animation:pulse 2s infinite}
.rt-badge .count{font-family:var(--font-mono);font-size:1.2rem;font-weight:700}
.rt-badge.sse .dot{background:var(--cyan)}
.rt-badge.sse .count{color:var(--cyan)}
.rt-badge.lp .dot{background:var(--blue)}
.rt-badge.lp .count{color:var(--blue)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}

/* Progress bar */
.progress-wrap{margin-top:8px}
.progress-bar{height:6px;background:var(--bg-elevated);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;border-radius:3px;transition:width 0.3s}

/* Test panel */
.test-layout{display:grid;grid-template-columns:2fr 3fr;gap:24px;min-height:500px}
.test-form{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:20px}
.test-form label{display:block;font-size:0.8rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;margin-top:16px}
.test-form label:first-child{margin-top:0}
.test-form input,.test-form select,.test-form textarea{width:100%;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--text);font-family:var(--font-mono);font-size:0.85rem;outline:none}
.test-form input:focus,.test-form select:focus,.test-form textarea:focus{border-color:var(--blue)}
.test-form textarea{min-height:120px;resize:vertical}
.test-form .actions{display:flex;gap:8px;margin-top:20px}
.test-form .actions button{flex:1;padding:10px;border:none;border-radius:6px;cursor:pointer;font-weight:500;font-size:0.85rem}
.btn-create{background:var(--green);color:#000}
.btn-append{background:var(--blue);color:#fff}
.btn-create:hover,.btn-append:hover{opacity:0.9}

.toggle-group{display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.toggle-group button{flex:1;padding:8px;border:none;background:var(--bg-elevated);color:var(--text-secondary);cursor:pointer;font-size:0.85rem}
.toggle-group button.active{background:var(--blue);color:#fff}

.event-log{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
.event-log .log-header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.event-log .log-header h3{font-size:0.85rem;color:var(--text-secondary);font-weight:500}
.event-log .log-header .status{font-size:0.75rem;font-family:var(--font-mono)}
.event-log .log-header .status.connected{color:var(--green)}
.event-log .log-header .status.disconnected{color:var(--text-muted)}
.log-entries{flex:1;overflow-y:auto;padding:8px;max-height:500px}
.log-entry{padding:8px 12px;border-radius:4px;margin-bottom:4px;font-family:var(--font-mono);font-size:0.8rem;background:var(--bg-elevated)}
.log-entry .time{color:var(--text-muted);margin-right:8px}
.log-entry .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.7rem;font-weight:600;margin-right:6px}
.badge-data{background:rgba(91,141,248,0.15);color:var(--blue)}
.badge-control{background:rgba(167,139,250,0.15);color:var(--purple)}
.badge-error{background:rgba(248,113,113,0.15);color:var(--red)}
.log-entry pre{margin-top:4px;white-space:pre-wrap;word-break:break-all;color:var(--text-secondary)}

.empty-state{text-align:center;padding:48px 24px;color:var(--text-muted)}
.empty-state .icon{font-size:2rem;margin-bottom:8px}

/* Scrollbar */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text-muted)}
</style>
</head>
<body>

<div class="header">
  <span class="dot"></span>
  <h1>Durable Streams</h1>
</div>

<div class="tabs">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="inspect">Inspect</div>
  <div class="tab" data-tab="test">Test</div>
</div>

<div class="content">
  <!-- Overview Panel -->
  <div class="panel active" id="panel-overview">
    <div class="stat-row" id="stat-cards">
      <div class="stat-card"><div class="label">Appends / min</div><div class="value blue" id="stat-appends">—</div><svg class="sparkline" id="spark-appends" viewBox="0 0 120 30" preserveAspectRatio="none"></svg></div>
      <div class="stat-card"><div class="label">Bytes / min</div><div class="value purple" style="color:var(--purple)" id="stat-bytes">—</div><svg class="sparkline" id="spark-bytes" viewBox="0 0 120 30" preserveAspectRatio="none"></svg></div>
      <div class="stat-card"><div class="label">Active Streams (24h)</div><div class="value green" id="stat-streams">—</div></div>
      <div class="stat-card"><div class="label">SSE Connects (1h)</div><div class="value cyan" id="stat-sse">—</div></div>
    </div>

    <div class="chart-wrap">
      <h3>Throughput (last hour)</h3>
      <svg id="timeseries-chart" viewBox="0 0 800 180" preserveAspectRatio="none"></svg>
    </div>

    <div class="table-wrap">
      <h3>Hot Streams (last 5 min)</h3>
      <table><thead><tr><th>Stream ID</th><th>Appends</th><th>Bytes</th></tr></thead><tbody id="hot-table"></tbody></table>
    </div>

    <div class="table-wrap">
      <h3>All Streams (last 24h)</h3>
      <table><thead><tr><th>Stream ID</th><th>Events</th><th>First Seen</th><th>Last Seen</th></tr></thead><tbody id="streams-table"></tbody></table>
    </div>
  </div>

  <!-- Inspect Panel -->
  <div class="panel" id="panel-inspect">
    <div class="search-bar">
      <input type="text" id="inspect-input" placeholder="Enter stream ID...">
      <button onclick="inspectStream()">Inspect</button>
    </div>
    <div id="inspect-result">
      <div class="empty-state"><div class="icon">&#x1F50D;</div><p>Enter a stream ID to inspect</p></div>
    </div>
  </div>

  <!-- Test Panel -->
  <div class="panel" id="panel-test">
    <div class="test-layout">
      <div class="test-form">
        <label>Stream ID</label>
        <input type="text" id="test-stream-id" placeholder="my-stream">

        <label>Action</label>
        <div class="toggle-group">
          <button class="active" onclick="setAction('create',this)">Create</button>
          <button onclick="setAction('append',this)">Append</button>
        </div>

        <label>Content Type</label>
        <select id="test-content-type">
          <option value="application/json">application/json</option>
          <option value="text/plain">text/plain</option>
          <option value="application/octet-stream">application/octet-stream</option>
        </select>

        <label>Body</label>
        <textarea id="test-body" placeholder='{"hello":"world"}'></textarea>

        <div class="actions">
          <button class="btn-create" id="test-send-btn" onclick="sendTest()">Send</button>
        </div>
      </div>

      <div class="event-log">
        <div class="log-header">
          <h3>Live Event Log</h3>
          <span class="status disconnected" id="sse-status">disconnected</span>
        </div>
        <div class="log-entries" id="log-entries">
          <div class="empty-state"><p>Enter a stream ID and click Send to start streaming</p></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
const CORE_URL = ${JSON.stringify(config.corePublicUrl)};
let currentAction = "create";
let sseSource = null;
let inspectTimer = null;
let overviewTimer = null;

// Tab switching
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");

    if (tab.dataset.tab === "overview") startOverviewPolling();
    else stopOverviewPolling();

    if (tab.dataset.tab !== "inspect") stopInspectPolling();
  });
});

// ==================== Overview ====================

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + " " + r.statusText);
  return r.json();
}

let sparkData = { appends: [], bytes: [] };

async function refreshOverview() {
  try {
    const [stats, streams, hot, ts] = await Promise.all([
      fetchJSON("/api/stats"),
      fetchJSON("/api/streams"),
      fetchJSON("/api/hot"),
      fetchJSON("/api/timeseries?window=60"),
    ]);

    // Stats
    const byType = {};
    for (const row of stats) byType[row.event_type] = row;
    const appends = byType.append?.total ?? 0;
    const bytes = byType.append?.total_bytes ?? 0;
    const sseCount = byType.sse_connect?.total ?? 0;

    document.getElementById("stat-appends").textContent = formatRate(appends, 60);
    document.getElementById("stat-bytes").textContent = formatBytes(bytes / 60) + "/m";
    document.getElementById("stat-streams").textContent = streams.length.toString();
    document.getElementById("stat-sse").textContent = sseCount.toString();

    // Sparklines
    sparkData.appends.push(appends);
    sparkData.bytes.push(bytes);
    if (sparkData.appends.length > 12) sparkData.appends.shift();
    if (sparkData.bytes.length > 12) sparkData.bytes.shift();
    drawSparkline("spark-appends", sparkData.appends, "var(--blue)");
    drawSparkline("spark-bytes", sparkData.bytes, "var(--purple)");

    // Timeseries
    drawTimeseries(ts);

    // Hot streams
    const hotBody = document.getElementById("hot-table");
    hotBody.innerHTML = hot.length === 0
      ? '<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">No activity</td></tr>'
      : hot.map(r => '<tr><td class="clickable" onclick="navigateInspect(\\''+esc(r.stream_id)+'\\')">'+esc(r.stream_id)+'</td><td>'+r.events+'</td><td>'+formatBytes(r.bytes)+'</td></tr>').join("");

    // All streams
    const sBody = document.getElementById("streams-table");
    sBody.innerHTML = streams.length === 0
      ? '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No streams</td></tr>'
      : streams.map(r => '<tr><td class="clickable" onclick="navigateInspect(\\''+esc(r.stream_id)+'\\')">'+esc(r.stream_id)+'</td><td>'+r.total_events+'</td><td>'+relTime(r.first_seen)+'</td><td>'+relTime(r.last_seen)+'</td></tr>').join("");
  } catch (e) {
    console.error("Overview refresh failed:", e);
  }
}

function startOverviewPolling() {
  refreshOverview();
  overviewTimer = setInterval(refreshOverview, 5000);
}

function stopOverviewPolling() {
  if (overviewTimer) { clearInterval(overviewTimer); overviewTimer = null; }
}

// Start on load
startOverviewPolling();

function drawSparkline(id, data, color) {
  const svg = document.getElementById(id);
  if (!data.length) return;
  const max = Math.max(...data, 1);
  const points = data.map((v, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * 120;
    const y = 30 - (v / max) * 26;
    return x + "," + y;
  }).join(" ");
  svg.innerHTML = '<polyline fill="none" stroke="' + color + '" stroke-width="1.5" points="' + points + '" />';
}

function drawTimeseries(ts) {
  const svg = document.getElementById("timeseries-chart");
  if (!ts.length) { svg.innerHTML = ""; return; }

  // Group by bucket
  const buckets = {};
  for (const row of ts) {
    if (!buckets[row.bucket]) buckets[row.bucket] = { appends: 0, bytes: 0 };
    if (row.event_type === "append") {
      buckets[row.bucket].appends += row.total;
      buckets[row.bucket].bytes += row.bytes;
    }
  }

  const keys = Object.keys(buckets).sort();
  if (!keys.length) { svg.innerHTML = ""; return; }

  const appendVals = keys.map(k => buckets[k].appends);
  const byteVals = keys.map(k => buckets[k].bytes);
  const maxA = Math.max(...appendVals, 1);
  const maxB = Math.max(...byteVals, 1);

  const w = 800, h = 160, pad = 20;
  const toPath = (vals, max) => {
    return vals.map((v, i) => {
      const x = pad + (i / Math.max(vals.length - 1, 1)) * (w - 2 * pad);
      const y = h - pad - (v / max) * (h - 2 * pad);
      return (i === 0 ? "M" : "L") + x + "," + y;
    }).join(" ");
  };
  const toArea = (vals, max) => {
    const line = toPath(vals, max);
    const lastX = pad + ((vals.length - 1) / Math.max(vals.length - 1, 1)) * (w - 2 * pad);
    return line + " L" + lastX + "," + (h - pad) + " L" + pad + "," + (h - pad) + " Z";
  };

  svg.innerHTML =
    '<defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--blue)" stop-opacity="0.3"/><stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="gB" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--purple)" stop-opacity="0.2"/><stop offset="100%" stop-color="var(--purple)" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + toArea(appendVals, maxA) + '" fill="url(#gA)" />' +
    '<path d="' + toPath(appendVals, maxA) + '" fill="none" stroke="var(--blue)" stroke-width="1.5" />' +
    '<path d="' + toArea(byteVals, maxB) + '" fill="url(#gB)" />' +
    '<path d="' + toPath(byteVals, maxB) + '" fill="none" stroke="var(--purple)" stroke-width="1.5" />';
}

// ==================== Inspect ====================

function navigateInspect(streamId) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelector('[data-tab="inspect"]').classList.add("active");
  document.getElementById("panel-inspect").classList.add("active");
  document.getElementById("inspect-input").value = streamId;
  stopOverviewPolling();
  inspectStream();
}

async function inspectStream() {
  const streamId = document.getElementById("inspect-input").value.trim();
  if (!streamId) return;
  stopInspectPolling();

  async function refresh() {
    try {
      const data = await fetchJSON("/api/stream/" + encodeURIComponent(streamId));
      renderInspection(data);
    } catch (e) {
      document.getElementById("inspect-result").innerHTML =
        '<div class="empty-state"><p style="color:var(--red)">' + esc(e.message) + '</p></div>';
      stopInspectPolling();
    }
  }

  await refresh();
  inspectTimer = setInterval(refresh, 2000);
}

function stopInspectPolling() {
  if (inspectTimer) { clearInterval(inspectTimer); inspectTimer = null; }
}

function renderInspection(data) {
  const m = data.meta;
  const ops = data.ops;
  const el = document.getElementById("inspect-result");

  const metaFields = [
    ["Stream ID", m.stream_id],
    ["Content Type", m.content_type],
    ["Status", m.closed ? "Closed" : "Open"],
    ["Created", relTime(m.created_at)],
    ["Tail Offset", m.tail_offset.toLocaleString() + " bytes"],
    ["Read Seq", m.read_seq],
    ["Segment Start", m.segment_start.toLocaleString()],
    ["Segment Messages", m.segment_messages],
    ["Segment Bytes", formatBytes(m.segment_bytes)],
    ["TTL", m.ttl_seconds ? m.ttl_seconds + "s" : "none"],
    ["Expires", m.expires_at ? relTime(m.expires_at) : "never"],
    ["Last Stream Seq", m.last_stream_seq ?? "—"],
  ];
  if (m.closed) {
    metaFields.push(["Closed At", relTime(m.closed_at)]);
    if (m.closed_by_producer_id) metaFields.push(["Closed By", m.closed_by_producer_id + " (epoch " + m.closed_by_epoch + ", seq " + m.closed_by_seq + ")"]);
  }

  let html = '<div class="realtime-row">';
  html += '<div class="rt-badge sse"><div class="dot"></div><div><div class="count">' + data.sseClientCount + '</div><div style="font-size:0.75rem;color:var(--text-muted)">SSE Clients</div></div></div>';
  html += '<div class="rt-badge lp"><div class="dot"></div><div><div class="count">' + data.longPollWaiterCount + '</div><div style="font-size:0.75rem;color:var(--text-muted)">Long-Poll Waiters</div></div></div>';
  html += '</div>';

  html += '<div class="meta-grid">';
  for (const [label, val] of metaFields) {
    html += '<div class="meta-item"><div class="label">' + esc(label) + '</div><div class="val">' + esc(String(val)) + '</div></div>';
  }
  html += '</div>';

  // Ops
  html += '<div class="stat-row"><div class="stat-card"><div class="label">Messages in Current Segment</div><div class="value blue">' + ops.messageCount + '</div>';
  html += '<div class="progress-wrap"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:4px">' + formatBytes(ops.sizeBytes) + '</div>';
  html += '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.min((ops.sizeBytes / (4 * 1024 * 1024)) * 100, 100) + '%;background:var(--blue)"></div></div></div>';
  html += '</div></div>';

  // Segments
  if (data.segments.length > 0) {
    html += '<div class="table-wrap"><h3>Segments (' + data.segments.length + ')</h3><table><thead><tr><th>Read Seq</th><th>Offset Range</th><th>Size</th><th>Messages</th><th>Created</th></tr></thead><tbody>';
    for (const s of data.segments) {
      html += '<tr><td>' + s.read_seq + '</td><td>' + s.start_offset.toLocaleString() + ' – ' + s.end_offset.toLocaleString() + '</td><td>' + formatBytes(s.size_bytes) + '</td><td>' + s.message_count + '</td><td>' + relTime(s.created_at) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }

  // Producers
  if (data.producers.length > 0) {
    html += '<div class="table-wrap"><h3>Producers (' + data.producers.length + ')</h3><table><thead><tr><th>ID</th><th>Epoch</th><th>Last Seq</th><th>Last Offset</th><th>Last Active</th></tr></thead><tbody>';
    for (const p of data.producers) {
      html += '<tr><td>' + esc(p.producer_id) + '</td><td>' + p.epoch + '</td><td>' + p.last_seq + '</td><td>' + p.last_offset.toLocaleString() + '</td><td>' + (p.last_updated ? relTime(p.last_updated) : '—') + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }

  el.innerHTML = html;
}

// ==================== Test ====================

function setAction(action, btn) {
  currentAction = action;
  btn.parentElement.querySelectorAll("button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const sendBtn = document.getElementById("test-send-btn");
  sendBtn.textContent = "Send";
  sendBtn.className = action === "create" ? "btn-create" : "btn-append";
}

async function sendTest() {
  const streamId = document.getElementById("test-stream-id").value.trim();
  if (!streamId) return;

  const body = document.getElementById("test-body").value;
  const contentType = document.getElementById("test-content-type").value;

  try {
    const r = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, contentType, body, action: currentAction }),
    });
    const result = await r.json();
    addLogEntry("control", currentAction.toUpperCase() + " => " + result.status + " " + result.statusText);

    // Connect SSE if not already
    connectSSE(streamId);
  } catch (e) {
    addLogEntry("error", e.message);
  }
}

function connectSSE(streamId) {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }

  if (!CORE_URL) {
    addLogEntry("error", "CORE_PUBLIC_URL not configured — SSE live log unavailable");
    return;
  }

  const url = CORE_URL + "/v1/stream/" + encodeURIComponent(streamId) + "?live=sse&offset=now";
  const statusEl = document.getElementById("sse-status");

  try {
    sseSource = new EventSource(url);
    statusEl.textContent = "connecting...";
    statusEl.className = "status";

    sseSource.addEventListener("open", () => {
      statusEl.textContent = "connected";
      statusEl.className = "status connected";
    });

    sseSource.addEventListener("data", (e) => {
      let display = e.data;
      try {
        const parsed = JSON.parse(e.data);
        display = JSON.stringify(parsed, null, 2);
      } catch {}
      addLogEntry("data", display);
    });

    sseSource.addEventListener("control", (e) => {
      addLogEntry("control", e.data);
    });

    sseSource.addEventListener("error", () => {
      statusEl.textContent = "disconnected";
      statusEl.className = "status disconnected";
    });
  } catch (e) {
    addLogEntry("error", "SSE connection failed: " + e.message);
  }
}

function addLogEntry(type, content) {
  const container = document.getElementById("log-entries");
  // Clear empty state
  if (container.querySelector(".empty-state")) container.innerHTML = "";

  const entry = document.createElement("div");
  entry.className = "log-entry";

  const now = new Date();
  const time = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const badgeClass = type === "data" ? "badge-data" : type === "error" ? "badge-error" : "badge-control";
  entry.innerHTML = '<span class="time">' + time + '</span><span class="badge ' + badgeClass + '">' + type + '</span>' +
    (content.includes("\\n") || content.length > 80 ? '<pre>' + esc(content) + '</pre>' : '<span style="color:var(--text-secondary)">' + esc(content) + '</span>');

  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// ==================== Helpers ====================

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatBytes(b) {
  if (b === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(Math.abs(b)) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  return (b / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 1) + " " + units[idx];
}

function formatRate(total, windowSec) {
  const perMin = (total / windowSec) * 60;
  return perMin < 10 ? perMin.toFixed(1) : Math.round(perMin).toString();
}

function relTime(ts) {
  if (!ts) return "—";
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  if (abs < 60000) return Math.round(abs / 1000) + "s ago";
  if (abs < 3600000) return Math.round(abs / 60000) + "m ago";
  if (abs < 86400000) return Math.round(abs / 3600000) + "h ago";
  return Math.round(abs / 86400000) + "d ago";
}

// Handle Enter in search
document.getElementById("inspect-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") inspectStream();
});
</script>
</body>
</html>`;
}
