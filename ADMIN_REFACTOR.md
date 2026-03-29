# Admin Dashboard Refactor Instructions

You are refactoring the Edge Seeker admin dashboard. The goal is to extract the 600+ line HTML template literal from `server.js` into a standalone `admin.html` file, and replace it with a clean JSON endpoint.

**Do not ask for confirmation. Execute all steps in order.**

---

## Step 1 — Create admin.html

Create a new file called `admin.html` in the project root (same directory as `server.js`) with exactly this content:

```html
<!DOCTYPE html>
<!--
  admin.html — Edge Seeker Admin Dashboard
  WHAT:    Standalone admin panel, extracted from the server.js template literal.
  CHANGED: All dynamic data now fetched via GET /api/admin/status on load.
           Secret stored in sessionStorage — never in the URL after initial auth.
  WHERE:   Place this file in the root of your project (same level as server.js).
           Add `app.use(express.static(__dirname))` in server.js if not already present,
           OR add a dedicated route: app.get('/admin.html', (req,res) => res.sendFile(...))
-->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge Seeker · Admin</title>
<style>
/* ── RESET & BASE ──────────────────────────────────────────────────────────── */
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --bg:        #080B10;
  --surface:   #0E1420;
  --border:    #1E2A40;
  --border-2:  #0D1525;
  --text:      #E8EDF5;
  --muted:     #6A7A95;
  --muted-2:   #8A9AB5;
  --cyan:      #00E5FF;
  --green:     #00FF88;
  --gold:      #FFD060;
  --red:       #FF3A5C;
  --sol:       #9945FF;
  --blue:      #4A90E2;
  --radius:    12px;
  --radius-sm: 8px;
  --gap:       16px;
}

body {
  font-family: 'Courier New', monospace;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  padding: 0;
}

/* ── LOADING SCREEN ────────────────────────────────────────────────────────── */
#loading {
  position: fixed; inset: 0;
  background: var(--bg);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 20px; z-index: 100;
}
#loading .logo { font-size: 22px; letter-spacing: 6px; color: var(--cyan); font-weight: bold; }
#loading .spinner {
  width: 32px; height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--cyan);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
#loading .load-text { font-size: 11px; letter-spacing: 3px; color: var(--muted); }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── ERROR SCREEN ──────────────────────────────────────────────────────────── */
#error-screen {
  display: none;
  position: fixed; inset: 0;
  background: var(--bg);
  flex-direction: column;
  align-items: center; justify-content: center;
  gap: 16px; text-align: center; padding: 32px;
}
#error-screen h2 { color: var(--red); font-size: 20px; letter-spacing: 2px; }
#error-screen p  { color: var(--muted); font-size: 13px; max-width: 300px; line-height: 1.6; }
#error-screen a  { color: var(--cyan); font-size: 13px; }

/* ── LAYOUT ────────────────────────────────────────────────────────────────── */
#app { display: none; flex-direction: column; min-height: 100vh; }

/* ── TOP NAV ───────────────────────────────────────────────────────────────── */
.topnav {
  position: sticky; top: 0; z-index: 50;
  background: rgba(8,11,16,0.92);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex; align-items: center; justify-content: space-between;
  height: 56px; gap: 12px;
}
.nav-logo { font-size: 15px; letter-spacing: 4px; color: var(--cyan); font-weight: bold; white-space: nowrap; }
.nav-sub  { font-size: 9px; letter-spacing: 2px; color: var(--muted); display: none; }
@media (min-width: 480px) { .nav-sub { display: block; } }

.nav-right { display: flex; align-items: center; gap: 10px; }
.status-pill {
  display: flex; align-items: center; gap: 7px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 11px; font-weight: bold; letter-spacing: 1px;
  white-space: nowrap;
}
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  animation: pulse 2s infinite;
}
.dot.ok   { background: var(--green); box-shadow: 0 0 6px var(--green); }
.dot.warn { background: var(--red);   box-shadow: 0 0 6px var(--red); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

.refresh-btn {
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--surface); border: 1px solid var(--border);
  color: var(--muted-2); cursor: pointer; font-size: 16px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.refresh-btn:hover { border-color: var(--cyan); color: var(--cyan); }
.refresh-btn.spinning { animation: spin 1s linear infinite; }

/* ── TAB BAR ───────────────────────────────────────────────────────────────── */
.tabbar {
  display: flex; overflow-x: auto; gap: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  padding: 0 20px;
  scrollbar-width: none;
}
.tabbar::-webkit-scrollbar { display: none; }
.tab {
  padding: 12px 18px;
  font-family: monospace; font-size: 11px; font-weight: bold;
  letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--muted); cursor: pointer; white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: all 0.2s; background: none; border-left: none;
  border-right: none; border-top: none;
}
.tab:hover  { color: var(--text); }
.tab.active { color: var(--cyan); border-bottom-color: var(--cyan); }

/* ── MAIN CONTENT ──────────────────────────────────────────────────────────── */
.main { padding: 20px; max-width: 1200px; margin: 0 auto; width: 100%; }

/* ── PANELS (tab content) ──────────────────────────────────────────────────── */
.panel { display: none; }
.panel.active { display: block; }

/* ── ALERT BANNER ──────────────────────────────────────────────────────────── */
.alert {
  border-radius: var(--radius);
  padding: 14px 18px;
  margin-bottom: 20px;
  font-size: 13px;
  display: flex; align-items: flex-start; gap: 10px;
  line-height: 1.5;
}
.alert.warn  { background: rgba(255,208,96,0.1);  border: 1px solid var(--gold);  color: var(--gold); }
.alert.error { background: rgba(255,58,92,0.1);   border: 1px solid var(--red);   color: var(--red); }
.alert a { color: inherit; text-decoration: underline; }

/* ── GRID ──────────────────────────────────────────────────────────────────── */
.grid {
  display: grid;
  gap: var(--gap);
  grid-template-columns: 1fr;
}
@media (min-width: 640px)  { .grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, 1fr); } }

.grid-2 {
  display: grid; gap: var(--gap);
  grid-template-columns: 1fr;
}
@media (min-width: 640px) { .grid-2 { grid-template-columns: repeat(2, 1fr); } }

/* ── CARD ──────────────────────────────────────────────────────────────────── */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
}
.card.t-cyan  { border-top: 2px solid var(--cyan); }
.card.t-green { border-top: 2px solid var(--green); }
.card.t-gold  { border-top: 2px solid var(--gold); }
.card.t-red   { border-top: 2px solid var(--red); }
.card.t-sol   { border-top: 2px solid var(--sol); }
.card.t-blue  { border-top: 2px solid var(--blue); }

.card-head {
  display: flex; align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.card-title { font-size: 10px; letter-spacing: 2.5px; color: var(--muted); text-transform: uppercase; }

.badge {
  font-size: 10px; padding: 3px 9px; border-radius: 999px;
  font-weight: bold; letter-spacing: 0.5px;
}
.badge.green { background: rgba(0,255,136,0.15); color: var(--green); }
.badge.red   { background: rgba(255,58,92,0.15);  color: var(--red); }
.badge.gold  { background: rgba(255,208,96,0.15); color: var(--gold); }
.badge.sol   { background: rgba(153,69,255,0.15); color: var(--sol); }
.badge.cyan  { background: rgba(0,229,255,0.15);  color: var(--cyan); }
.badge.blue  { background: rgba(74,144,226,0.15); color: var(--blue); }

/* ── STAT ROWS ─────────────────────────────────────────────────────────────── */
.row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-2);
  font-size: 13px; gap: 8px;
  min-height: 36px; /* touch target */
}
.row:last-child { border-bottom: none; padding-bottom: 0; }
.row-label { color: var(--muted); flex-shrink: 0; font-size: 12px; }
.row-value { font-weight: bold; text-align: right; word-break: break-all; }

/* ── COLOR UTILS ───────────────────────────────────────────────────────────── */
.c-green { color: var(--green); }
.c-cyan  { color: var(--cyan); }
.c-gold  { color: var(--gold); }
.c-red   { color: var(--red); }
.c-sol   { color: var(--sol); }
.c-white { color: var(--text); }
.c-muted { color: var(--muted-2); }
.c-blue  { color: var(--blue); }

/* ── SECTION LABEL ─────────────────────────────────────────────────────────── */
.section-label {
  font-size: 10px; letter-spacing: 3px; color: var(--muted);
  text-transform: uppercase;
  margin: 28px 0 14px;
  display: flex; align-items: center; gap: 10px;
}
.section-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.section-label:first-child { margin-top: 0; }

/* ── ACTIONS GRID ──────────────────────────────────────────────────────────── */
.actions-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(2, 1fr);
}
@media (min-width: 480px) { .actions-grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 768px) { .actions-grid { grid-template-columns: repeat(4, 1fr); } }

.btn {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted-2);
  font-family: monospace; font-size: 12px; font-weight: bold;
  letter-spacing: 0.5px;
  padding: 13px 12px; /* 44px min touch target */
  cursor: pointer; text-decoration: none;
  transition: all 0.18s;
  text-align: center; line-height: 1.3;
  min-height: 44px;
}
.btn:hover { border-color: var(--cyan); color: var(--cyan); background: rgba(0,229,255,0.05); }
.btn.danger:hover { border-color: var(--red); color: var(--red); background: rgba(255,58,92,0.05); }
.btn.primary { border-color: var(--cyan); color: var(--cyan); }

/* ── RESULT FORM ───────────────────────────────────────────────────────────── */
.form-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
}
.form-card p { font-size: 13px; color: var(--muted); margin-bottom: 20px; line-height: 1.6; }
.form-card a { color: var(--cyan); }

.form-grid {
  display: grid; gap: 12px;
  grid-template-columns: 1fr;
}
@media (min-width: 480px) {
  .form-grid { grid-template-columns: 1fr 160px auto; align-items: end; }
}

.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 10px; letter-spacing: 1.5px; color: var(--muted); text-transform: uppercase; }
.field input,
.field select {
  background: #141C2E;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: monospace; font-size: 16px; /* 16px prevents iOS zoom */
  padding: 12px 14px; width: 100%; outline: none;
  transition: border-color 0.2s;
  min-height: 44px;
}
.field input:focus,
.field select:focus { border-color: var(--cyan); }

.submit-btn {
  background: linear-gradient(135deg, var(--cyan), #7B61FF);
  border: none; border-radius: var(--radius-sm);
  color: var(--bg); font-family: monospace;
  font-size: 13px; font-weight: bold;
  padding: 12px 20px; cursor: pointer;
  transition: opacity 0.2s;
  letter-spacing: 0.5px; white-space: nowrap;
  min-height: 44px; width: 100%;
}
.submit-btn:hover { opacity: 0.85; }

#updateMsg {
  margin-top: 12px; font-size: 13px;
  padding: 10px 14px; border-radius: var(--radius-sm);
  display: none;
}
#updateMsg.ok  { background: rgba(0,255,136,0.1); color: var(--green); border: 1px solid var(--green); }
#updateMsg.err { background: rgba(255,58,92,0.1);  color: var(--red);   border: 1px solid var(--red); }

/* ── BYPASS TOGGLE ─────────────────────────────────────────────────────────── */
.bypass-btn {
  width: 100%; padding: 12px; border-radius: var(--radius-sm);
  border: none; cursor: pointer;
  font-family: monospace; font-size: 12px; font-weight: 700;
  letter-spacing: 1px; transition: opacity 0.2s;
  min-height: 44px;
}

/* ── CHECKLIST ─────────────────────────────────────────────────────────────── */
.checklist {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.check-item {
  display: flex; align-items: flex-start; gap: 14px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-2);
  font-size: 13px; line-height: 1.5;
  min-height: 52px;
}
.check-item:last-child { border-bottom: none; }
.check-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
.check-text { color: var(--muted-2); flex: 1; }
.check-link {
  font-size: 11px; color: var(--cyan); text-decoration: none;
  flex-shrink: 0; padding: 4px 0; /* touch area */
}
.check-link:hover { text-decoration: underline; }

code {
  background: #141C2E; padding: 2px 7px;
  border-radius: 4px; color: var(--cyan); font-size: 11px;
}

/* ── META ROW ──────────────────────────────────────────────────────────────── */
.meta-row {
  font-size: 11px; color: var(--muted);
  text-align: center; padding: 20px;
  border-top: 1px solid var(--border);
  margin-top: 32px; letter-spacing: 1px;
}
</style>
</head>
<body>

<!-- LOADING -->
<div id="loading">
  <div class="logo">EDGE SEEKER</div>
  <div class="spinner"></div>
  <div class="load-text">LOADING DASHBOARD</div>
</div>

<!-- AUTH ERROR -->
<div id="error-screen">
  <h2>⛔ UNAUTHORIZED</h2>
  <p>No admin secret found. Access this page via <code>/admin?secret=YOUR_SECRET</code></p>
  <a href="/">← Back to app</a>
</div>

<!-- APP SHELL -->
<div id="app">

  <!-- TOP NAV -->
  <nav class="topnav">
    <div>
      <div class="nav-logo">⚾ EDGE SEEKER</div>
      <div class="nav-sub">ADMIN DASHBOARD</div>
    </div>
    <div class="nav-right">
      <div class="status-pill">
        <div class="dot" id="healthDot"></div>
        <span id="healthLabel">CHECKING</span>
      </div>
      <button class="refresh-btn" id="refreshBtn" onclick="refreshData()" title="Refresh data">↻</button>
    </div>
  </nav>

  <!-- TAB BAR -->
  <div class="tabbar">
    <button class="tab active" onclick="switchTab('overview')">Overview</button>
    <button class="tab" onclick="switchTab('cache')">Cache</button>
    <button class="tab" onclick="switchTab('sharp')">Sharp Money</button>
    <button class="tab" onclick="switchTab('actions')">Actions</button>
    <button class="tab" onclick="switchTab('results')">Results</button>
    <button class="tab" onclick="switchTab('maintenance')">Maintenance</button>
  </div>

  <!-- MAIN -->
  <main class="main">

    <!-- ── ALERT BANNER ── -->
    <div id="alertBanner" style="display:none"></div>

    <!-- ══════════════════════════════════════════════ -->
    <!-- TAB: OVERVIEW                                  -->
    <!-- ══════════════════════════════════════════════ -->
    <div id="panel-overview" class="panel active">

      <div class="section-label">System Status</div>
      <div class="grid">

        <div class="card t-cyan">
          <div class="card-head">
            <span class="card-title">Odds API</span>
            <span class="badge" id="quotaBadge">—</span>
          </div>
          <div class="row"><span class="row-label">Remaining</span><span class="row-value c-cyan" id="quotaRemaining">—</span></div>
          <div class="row"><span class="row-label">Used this month</span><span class="row-value c-white" id="quotaUsed">—</span></div>
          <div class="row"><span class="row-label">Monthly limit</span><span class="row-value c-muted">500 (free tier)</span></div>
          <div class="row"><span class="row-label">Resets</span><span class="row-value c-muted">1st of month</span></div>
        </div>

        <div class="card t-green">
          <div class="card-head">
            <span class="card-title">Database</span>
            <span class="badge green">CONNECTED</span>
          </div>
          <div class="row"><span class="row-label">Total users</span><span class="row-value c-green" id="dbUsers">—</span></div>
          <div class="row"><span class="row-label">Picks logged</span><span class="row-value c-white" id="dbBets">—</span></div>
          <div class="row"><span class="row-label">Provider</span><span class="row-value c-muted">Supabase</span></div>
          <div class="row"><span class="row-label">Free tier limit</span><span class="row-value c-muted">500 MB</span></div>
        </div>

        <div class="card t-gold">
          <div class="card-head">
            <span class="card-title">AI Agent</span>
            <span class="badge" id="agentBadge">—</span>
          </div>
          <div class="row"><span class="row-label">Free model</span><span class="row-value c-white" id="agentFreeModel">—</span></div>
          <div class="row"><span class="row-label">Premium model</span><span class="row-value c-white" id="agentPremModel">—</span></div>
          <div class="row"><span class="row-label">Auto-run times</span><span class="row-value c-gold">11:05 AM + 5:05 PM ET</span></div>
          <div class="row"><span class="row-label">Last run</span><span class="row-value" id="agentLastRun">—</span></div>
          <div class="row"><span class="row-label">Status</span><span class="row-value" id="agentStatus">—</span></div>
        </div>

        <div class="card t-sol">
          <div class="card-head">
            <span class="card-title">Server</span>
            <span class="badge sol">LIVE</span>
          </div>
          <div class="row"><span class="row-label">Environment</span><span class="row-value c-white">Vercel Production</span></div>
          <div class="row"><span class="row-label">Uptime</span><span class="row-value c-green" id="uptime">—</span></div>
          <div class="row"><span class="row-label">Node version</span><span class="row-value c-white" id="nodeVer">—</span></div>
          <div class="row"><span class="row-label">Heap used</span><span class="row-value c-white" id="heapMB">—</span></div>
          <div class="row"><span class="row-label">Timestamp</span><span class="row-value c-muted" id="serverTime">—</span></div>
        </div>

        <div class="card t-blue">
          <div class="card-head">
            <span class="card-title">Season</span>
            <span class="badge" id="seasonBadge">—</span>
          </div>
          <div class="row"><span class="row-label">Season</span><span class="row-value c-white">2026 MLB</span></div>
          <div class="row"><span class="row-label">Opening Day</span><span class="row-value c-cyan">March 25, 2026</span></div>
          <div class="row"><span class="row-label">Status</span><span class="row-value" id="seasonStatus">—</span></div>
          <div class="row"><span class="row-label">Data source</span><span class="row-value" id="dataSource">—</span></div>
        </div>

        <div class="card t-sol">
          <div class="card-head">
            <span class="card-title">Wallet Split</span>
            <span class="badge" id="splitBadge">—</span>
          </div>
          <div class="row"><span class="row-label">Prize Pool</span><span class="row-value" id="prizePoolStatus">—</span></div>
          <div class="row"><span class="row-label">Operations</span><span class="row-value c-sol" id="splitOps">—</span></div>
          <div class="row"><span class="row-label">Prize Pool</span><span class="row-value c-sol" id="splitPool">—</span></div>
          <div class="row"><span class="row-label">Treasury</span><span class="row-value c-sol" id="splitTreas">—</span></div>
        </div>

      </div>
    </div>

    <!-- ══════════════════════════════════════════════ -->
    <!-- TAB: CACHE                                     -->
    <!-- ══════════════════════════════════════════════ -->
    <div id="panel-cache" class="panel">

      <div class="section-label">Cache Status</div>
      <div class="grid">

        <div class="card t-cyan">
          <div class="card-head">
            <span class="card-title">Picks Cache</span>
            <span class="badge" id="cacheBadge">—</span>
          </div>
          <div class="row"><span class="row-label">Status</span><span class="row-value" id="cacheStatus">—</span></div>
          <div class="row"><span class="row-label">Last fetched</span><span class="row-value c-white" id="cacheFetchedAt">—</span></div>
          <div class="row"><span class="row-label">Age</span><span class="row-value c-muted" id="cacheAge">—</span></div>
          <div class="row"><span class="row-label">Picks stored</span><span class="row-value" id="cachePicksCount">—</span></div>
          <div class="row"><span class="row-label">Games analyzed</span><span class="row-value c-white" id="cacheGames">—</span></div>
        </div>

        <div class="card t-red">
          <div class="card-head">
            <span class="card-title">Cache Bypass</span>
            <span class="badge" id="bypassBadge">—</span>
          </div>
          <div class="row"><span class="row-label">Status</span><span class="row-value" id="bypassStatus">—</span></div>
          <div class="row"><span class="row-label">Warning</span><span class="row-value" style="color:var(--gold);font-size:11px">Uses 1 API call per refresh</span></div>
          <div class="row" style="padding-top:12px">
            <button class="bypass-btn" id="bypassBtn" onclick="toggleBypass()">—</button>
          </div>
        </div>

        <div class="card t-blue">
          <div class="card-head">
            <span class="card-title">Refresh Windows</span>
            <span class="badge sol">2× DAILY</span>
          </div>
          <div class="row"><span class="row-label">Morning</span><span class="row-value c-cyan">11:00 AM ET</span></div>
          <div class="row"><span class="row-label">Afternoon</span><span class="row-value c-cyan">5:00 PM ET</span></div>
          <div class="row"><span class="row-label">Last window</span><span class="row-value c-white" id="lastRefresh">—</span></div>
          <div class="row"><span class="row-label">Next window</span><span class="row-value c-gold" id="nextRefresh">—</span></div>
        </div>

        <div class="card t-sol">
          <div class="card-head">
            <span class="card-title">API Budget</span>
            <span class="badge green">2/DAY</span>
          </div>
          <div class="row"><span class="row-label">Calls per day</span><span class="row-value c-green">2 (odds refresh)</span></div>
          <div class="row"><span class="row-label">Calls per month</span><span class="row-value c-white">~62</span></div>
          <div class="row"><span class="row-label">Monthly quota</span><span class="row-value c-muted">500 (free tier)</span></div>
          <div class="row"><span class="row-label">Buffer remaining</span><span class="row-value c-green">~438 calls free</span></div>
        </div>

      </div>
    </div>

    <!-- ══════════════════════════════════════════════ -->
    <!-- TAB: SHARP MONEY                               -->
    <!-- ══════════════════════════════════════════════ -->
    <div id="panel-sharp" class="panel">

      <div class="section-label">Pinnacle Line Movement</div>
      <div class="grid">

        <div class="card t-red">
          <div class="card-head">
            <span class="card-title">API Config</span>
            <span class="badge" id="sharpApiBadge">—</span>
          </div>
          <div class="row"><span class="row-label">Plan</span><span class="row-value" id="sharpPlan">—</span></div>
          <div class="row"><span class="row-label">Books tracked</span><span class="row-value c-white" id="sharpBooks">—</span></div>
          <div class="row"><span class="row-label">Steam threshold</span><span class="row-value c-muted">8+ pts</span></div>
          <div class="row"><span class="row-label">Significant threshold</span><span class="row-value c-muted">5–7 pts</span></div>
        </div>

        <div class="card t-red">
          <div class="card-head">
            <span class="card-title">Today's Signals</span>
            <span class="badge red">LIVE</span>
          </div>
          <div class="row"><span class="row-label">Opening lines stored</span><span class="row-value c-white" id="openingLines">—</span></div>
          <div class="row"><span class="row-label">Significant moves</span><span class="row-value c-gold" id="sigMoves">—</span></div>
          <div class="row"><span class="row-label">Steam moves</span><span class="row-value c-red" id="steamMoves">—</span></div>
          <div class="row"><span class="row-label">Date</span><span class="row-value c-muted" id="sharpDate">—</span></div>
        </div>

        <div class="card t-red">
          <div class="card-head">
            <span class="card-title">Pick Impact</span>
            <span class="badge green">TODAY</span>
          </div>
          <div class="row"><span class="row-label">Sharp confirms</span><span class="row-value c-green" id="sharpConfirm">—</span></div>
          <div class="row"><span class="row-label">Sharp fades</span><span class="row-value c-red" id="sharpFade">—</span></div>
          <div class="row"><span class="row-label">Steam confirms</span><span class="row-value c-green" id="steamConfirm">—</span></div>
          <div class="row"><span class="row-label">Steam fades</span><span class="row-value c-red" id="steamFade">—</span></div>
        </div>

      </div>
    </div>

    <!-- ══════════════════════════════════════════════ -->
    <!-- TAB: ACTIONS                                   -->
    <!-- ══════════════════════════════════════════════ -->
    <div id="panel-actions" class="panel">

      <div class="section-label">Monitoring</div>
      <div class="actions-grid">
        <a class="btn primary" id="link-health"  href="/api/health"   target="_blank">🔍 Health Check</a>
        <a class="btn"         id="link-picks"   href="/api/picks"    target="_blank">⚡ View Picks</a>
        <a class="btn"         id="link-quota"   href="/api/quota"    target="_blank">📊 API Quota</a>
        <a class="btn"         id="link-accuracy" href="/api/accuracy" target="_blank">🎯 Accuracy</a>
        <a class="btn"         id="link-leader"  href="/api/leaderboard" target="_blank">🏆 Leaderboard</a>
        <a class="btn"         id="link-elo"     href="/api/elo"      target="_blank">📈 Elo Ratings</a>
        <a class="btn"         id="link-cache-status" href="/api/cache/status" target="_blank">📡 Cache Status</a>
        <a class="btn primary" id="link-sharp"   href="/api/sharp/movement" target="_blank">⚡ Sharp Movement</a>
      </div>

      <div class="section-label">Operations</div>
      <div class="actions-grid">
        <a class="btn primary" id="link-agent"   target="_blank">🤖 Test Premium Agent</a>
        <a class="btn primary" id="link-refresh-picks" target="_blank">🔄 Refresh Picks Now</a>
        <a class="btn primary" id="link-run-agent"     target="_blank">🤖 Run Agent Now</a>
        <a class="btn"         id="link-update-stats"  target="_blank">⚾ Run Stats Update</a>
        <a class="btn"         id="link-update-elo"    target="_blank">📈 Update Elo</a>
        <a class="btn"         id="link-auto-log"      target="_blank">📊 Auto-Log Results</a>
        <a class="btn"         id="link-digest"        target="_blank">📨 Send Digest</a>
        <a class="btn"         id="link-split"         target="_blank">💸 Split Config</a>
        <a class="btn danger"  id="link-refresh-agent" target="_blank">🔄 Refresh Agent Cache</a>
        <a class="btn"         href="https://edge-seeker.vercel.app" target="_blank">🌐 View Live App</a>
      </div>

    </div>

    <!-- ══════════════════════════════════════════════ -->
    <!-- TAB: RESULTS                                   -->
    <!-- ══════════════════════════════════════════════ -->
    <div id="panel-results" class="panel">

      <div class="section-label">Update Pick Result</div>
      <div class="form-card">
        <p>Mark a pick as Win / Loss / Push after the game resolves. Find the pick ID from <a href="/api/accuracy" target="_blank">/api/accuracy</a>.</p>
        <div class="form-grid">
          <div class="field">
            <label>Pick ID</label>
            <input id="pickId" type="number" placeholder="e.g. 42" inputmode="numeric" />
          </div>
          <div class="field">
            <label>Result</label>
            <select id="pickResult">
              <option value="win">WIN ✓</option>
              <option value="loss">LOSS ✗</option>
              <option value="push">PUSH ~</option>
              <option value="void">VOID</option>
            </select>
          </div>
          <div class="field">
            <label>&nbsp;</label>
            <button class="submit-btn" onclick="updateResult()">UPDATE RESULT</button>
          </div>
        </div>
        <div id="updateMsg"></div>
      </div>

    </div>

    <!-- ══════════════════════════════════════════════ -->
    <!-- TAB: MAINTENANCE                               -->
    <!-- ══════════════════════════════════════════════ -->
    <div id="panel-maintenance" class="panel">

      <div class="section-label">Monthly Checklist</div>
      <div class="checklist">
        <div class="check-item">
          <div class="check-icon">📊</div>
          <div class="check-text">Check Odds API quota — upgrade if below 100 remaining</div>
          <a class="check-link" href="https://the-odds-api.com" target="_blank">Visit →</a>
        </div>
        <div class="check-item">
          <div class="check-icon">🤖</div>
          <div class="check-text">Check Anthropic credit balance</div>
          <a class="check-link" href="https://console.anthropic.com/settings/billing" target="_blank">Visit →</a>
        </div>
        <div class="check-item">
          <div class="check-icon">⚾</div>
          <div class="check-text">Update mlbStats.js with real team run averages once season starts</div>
          <a class="check-link" href="https://baseball-reference.com/leagues/majors/2026.shtml" target="_blank">Visit →</a>
        </div>
        <div class="check-item">
          <div class="check-icon">🗄️</div>
          <div class="check-text">Check Supabase database size — free tier limit is 500 MB</div>
          <a class="check-link" href="https://supabase.com/dashboard" target="_blank">Visit →</a>
        </div>
        <div class="check-item">
          <div class="check-icon">🚀</div>
          <div class="check-text">Review Vercel deployment logs and function usage</div>
          <a class="check-link" href="https://vercel.com/dashboard" target="_blank">Visit →</a>
        </div>
        <div class="check-item">
          <div class="check-icon">🔐</div>
          <div class="check-text">Dashboard access via <code>/admin?secret=YOUR_SECRET</code> — keep secret rotated</div>
        </div>
      </div>

    </div>

    <!-- META -->
    <div class="meta-row" id="metaRow">EDGE SEEKER ADMIN · LOADING…</div>

  </main>
</div>

<script>
/* ── STATE ──────────────────────────────────────────────────────────────── */
let SECRET = sessionStorage.getItem('adminSecret') || '';
let statusData = null;

/* ── INIT ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  if (!SECRET) {
    // Try to extract from URL as fallback (only on first load)
    const params = new URLSearchParams(window.location.search);
    const s = params.get('secret');
    if (s) {
      SECRET = s;
      sessionStorage.setItem('adminSecret', s);
      // Clean secret from URL
      history.replaceState({}, '', '/admin.html');
    } else {
      showError();
      return;
    }
  }
  await loadData();
});

/* ── FETCH STATUS ────────────────────────────────────────────────────────── */
async function loadData() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');

  try {
    const res = await fetch(`/api/admin/status?secret=${SECRET}`);
    if (res.status === 403) { showError(); return; }
    statusData = await res.json();
    render(statusData);
  } catch (e) {
    console.error('Failed to load admin status:', e);
  } finally {
    btn.classList.remove('spinning');
  }

  // Also load sharp money data
  loadSharpData();
}

async function refreshData() { await loadData(); }

/* ── RENDER ──────────────────────────────────────────────────────────────── */
function render(d) {
  // Show app
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('app').style.flexDirection = 'column';

  // ── Quota ──
  const qr = parseInt(d.quota.remaining);
  const quotaEmergency = !isNaN(qr) && qr < 50;
  const quotaCritical  = !isNaN(qr) && qr < 100;
  const quotaWarning   = !isNaN(qr) && qr < 200;

  setText('quotaRemaining', d.quota.remaining);
  setText('quotaUsed', d.quota.used);
  setBadge('quotaBadge',
    quotaEmergency ? ['CRITICAL','red'] :
    quotaCritical  ? ['CRITICAL','red'] :
    quotaWarning   ? ['LOW','gold'] : ['HEALTHY','green']
  );

  // ── Alert banner ──
  const alertEl = document.getElementById('alertBanner');
  if (quotaEmergency) {
    alertEl.style.display = 'flex';
    alertEl.className = 'alert error';
    alertEl.innerHTML = `🚨 <strong>QUOTA CRITICAL — AUTO-REFRESH PAUSED</strong> — Only ${d.quota.remaining} requests remaining. <a href="https://the-odds-api.com" target="_blank">Upgrade now →</a>`;
  } else if (quotaWarning) {
    alertEl.style.display = 'flex';
    alertEl.className = 'alert warn';
    alertEl.innerHTML = `⚠️ <strong>QUOTA ${quotaCritical ? 'CRITICAL' : 'WARNING'}</strong> — ${d.quota.remaining} requests remaining. <a href="https://the-odds-api.com" target="_blank">Monitor →</a>`;
  } else {
    alertEl.style.display = 'none';
  }

  // ── Health pill ──
  const healthy = !quotaEmergency;
  setEl('healthDot', el => { el.className = `dot ${healthy ? 'ok' : 'warn'}`; });
  setText('healthLabel', healthy ? 'ALL OK' : 'ATTENTION');

  // ── DB ──
  setText('dbUsers', d.db.users);
  setText('dbBets', d.db.bets);

  // ── Agent ──
  const agentColor = d.agent.status === 'running' ? 'gold' : d.agent.status === 'failed' ? 'red' : 'green';
  setBadge('agentBadge', [d.agent.status.toUpperCase(), agentColor]);
  setText('agentFreeModel', d.agent.freeModel);
  setText('agentPremModel', d.agent.premiumModel);
  setEl('agentLastRun', el => {
    el.textContent = d.agent.lastRun || 'Not yet today';
    el.className = 'row-value ' + (d.agent.lastRun ? 'c-green' : 'c-muted');
  });
  setEl('agentStatus', el => {
    el.textContent = d.agent.status === 'ready' ? '✅ Ready' : d.agent.status === 'running' ? '⏳ Running…' : '❌ Failed';
    el.className = 'row-value ' + (d.agent.status === 'ready' ? 'c-green' : d.agent.status === 'running' ? 'c-gold' : 'c-red');
  });

  // ── Server ──
  setText('uptime', `${d.uptime} min`);
  setText('nodeVer', d.nodeVersion);
  setText('heapMB', `${d.heapUsedMB} MB`);
  setText('serverTime', d.timestamp);

  // ── Season ──
  setBadge('seasonBadge', d.season.started ? ['IN SEASON','green'] : ['PRE-SEASON','gold']);
  setEl('seasonStatus', el => {
    el.textContent = d.season.started ? '✅ Active' : `${d.season.daysUntilOpening} days away`;
    el.className = 'row-value ' + (d.season.started ? 'c-green' : 'c-gold');
  });
  setEl('dataSource', el => {
    el.textContent = d.season.dataSource;
    el.className = 'row-value ' + (d.season.started ? 'c-green' : 'c-gold');
  });

  // ── Split ──
  setBadge('splitBadge', d.split.prizePoolEnabled ? ['POOL ON','green'] : ['POOL OFF','red']);
  setEl('prizePoolStatus', el => {
    el.textContent = d.split.prizePoolEnabled ? '✅ ENABLED' : '⛔ DISABLED';
    el.className = 'row-value ' + (d.split.prizePoolEnabled ? 'c-green' : 'c-red');
  });
  setText('splitOps',   `${d.split.active.operations}%`);
  setText('splitPool',  `${d.split.active.prizePool}%`);
  setText('splitTreas', `${d.split.active.treasury}%`);

  // ── Cache ──
  setBadge('cacheBadge', d.cache.isValid ? ['FRESH','green'] : ['STALE','red']);
  setEl('cacheStatus', el => {
    el.textContent = d.cache.isValid ? '✅ Serving cached' : '⚠️ Will refresh on next call';
    el.className = 'row-value ' + (d.cache.isValid ? 'c-green' : 'c-red');
  });
  setText('cacheFetchedAt', d.cache.fetchedAt ? fmtTime(d.cache.fetchedAt) + ' ET' : 'Never');
  setText('cacheAge', d.cache.ageMinutes !== null ? `${d.cache.ageMinutes} min` : 'Empty');
  setEl('cachePicksCount', el => {
    el.textContent = d.cache.hasData ? `${d.cache.picksCount} picks` : 'Empty';
    el.className = 'row-value ' + (d.cache.hasData ? 'c-green' : 'c-red');
  });
  setText('cacheGames', d.cache.gamesAnalyzed || '—');
  setText('lastRefresh', d.cache.lastRefresh ? fmtTime(d.cache.lastRefresh) + ' ET' : 'N/A');
  setText('nextRefresh', d.cache.nextRefresh ? fmtTime(d.cache.nextRefresh) + ' ET' : 'N/A');

  // ── Bypass ──
  renderBypass(d.cache.bypass);

  // ── Sharp Money Config ──
  setBadge('sharpApiBadge', d.sharpMoney.oddsApiUpgraded ? ['UPGRADED','green'] : ['STANDARD','gold']);
  setEl('sharpPlan', el => {
    el.textContent = d.sharpMoney.oddsApiUpgraded ? 'UPGRADED — All sharp books' : 'STANDARD — Pinnacle only';
    el.className = 'row-value ' + (d.sharpMoney.oddsApiUpgraded ? 'c-green' : 'c-gold');
  });
  setText('sharpBooks', d.sharpMoney.booksTracked.join(', '));

  // ── Action links ──
  setActionLinks(d);

  // ── Meta row ──
  setText('metaRow', `EDGE SEEKER ADMIN · ${d.timestamp} ET · Uptime ${d.uptime} min`);
}

/* ── BYPASS TOGGLE ───────────────────────────────────────────────────────── */
function renderBypass(enabled) {
  setBadge('bypassBadge', enabled ? ['LIVE — NO CACHE','red'] : ['CACHED','green']);
  setEl('bypassStatus', el => {
    el.textContent = enabled ? '🔴 ENABLED — hitting API live' : '🟢 DISABLED — serving cache';
    el.className = 'row-value ' + (enabled ? 'c-red' : 'c-green');
  });
  const btn = document.getElementById('bypassBtn');
  btn.style.background = enabled ? '#22c55e' : '#ef4444';
  btn.style.color = '#fff';
  btn.textContent = enabled ? '✅ DISABLE BYPASS' : '🔄 BYPASS CACHE';
}

async function toggleBypass() {
  const btn = document.getElementById('bypassBtn');
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const res = await fetch('/api/admin/cache-bypass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET }),
    });
    const data = await res.json();
    if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
    renderBypass(data.cacheBypas);
  } catch (e) {
    alert('Request failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ── SHARP DATA ──────────────────────────────────────────────────────────── */
async function loadSharpData() {
  try {
    const res = await fetch('/api/sharp/movement');
    const d = await res.json();
    setText('openingLines', d.openingLinesStored ?? '—');
    setText('sigMoves',     d.significantMovesToday ?? '—');
    setText('steamMoves',   d.steamMovesToday ?? '—');
    setText('sharpDate',    d.date ?? '—');
    // Confirm/fade counts from cached picks
    let conf = 0, fade = 0, steamConf = 0, steamFade = 0;
    for (const p of (d.movement || [])) {
      const sig = p.pinnacleMovement?.sharpSignal;
      if (sig === 'strong_confirm_home' || sig === 'strong_confirm_away') { conf++; steamConf++; }
      else if (sig === 'confirm_home'   || sig === 'confirm_away')         conf++;
      else if (sig === 'strong_fade')                                       { fade++; steamFade++; }
      else if (sig === 'fade')                                              fade++;
    }
    setText('sharpConfirm', conf);
    setText('sharpFade',    fade);
    setText('steamConfirm', steamConf);
    setText('steamFade',    steamFade);
  } catch (e) { /* non-blocking */ }
}

/* ── UPDATE RESULT ───────────────────────────────────────────────────────── */
async function updateResult() {
  const id = document.getElementById('pickId').value.trim();
  const result = document.getElementById('pickResult').value;
  if (!id) { alert('Enter a pick ID'); return; }

  const res = await fetch(`/api/accuracy/result/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, result }),
  });
  const data = await res.json();
  const msg = document.getElementById('updateMsg');
  msg.style.display = 'block';
  msg.className = res.ok ? 'ok' : 'err';
  msg.textContent = res.ok
    ? `✅ Pick #${id} updated to ${result.toUpperCase()}`
    : `❌ Error: ${data.error}`;
  setTimeout(() => { msg.style.display = 'none'; }, 5000);
}

/* ── ACTION LINKS ────────────────────────────────────────────────────────── */
function setActionLinks(d) {
  const s = SECRET;
  const links = {
    'link-agent':         `/api/agent/premium?wallet=8YPA4TV2rKkFdeJwvhQZPm6CNMNAm9sjP98p3DZSEgcL`,
    'link-refresh-picks': `/api/cron/refresh-picks?secret=${s}`,
    'link-run-agent':     `/api/cron/auto-run-agent?secret=${s}`,
    'link-update-stats':  `/api/cron/update-stats?secret=${s}`,
    'link-update-elo':    `/api/cron/update-elo?secret=${s}`,
    'link-auto-log':      `/api/cron/auto-log-results?secret=${s}`,
    'link-digest':        `/api/digest/send?secret=${s}`,
    'link-split':         `/api/admin/split-config?secret=${s}`,
    'link-refresh-agent': `/admin/refresh-agent?secret=${s}`,
  };
  for (const [id, href] of Object.entries(links)) {
    const el = document.getElementById(id);
    if (el) el.href = href;
  }
}

/* ── TABS ────────────────────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`panel-${name}`).classList.add('active');
  event.target.classList.add('active');
}

/* ── ERROR ───────────────────────────────────────────────────────────────── */
function showError() {
  document.getElementById('loading').style.display = 'none';
  const es = document.getElementById('error-screen');
  es.style.display = 'flex';
}

/* ── HELPERS ─────────────────────────────────────────────────────────────── */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setEl(id, fn) {
  const el = document.getElementById(id);
  if (el) fn(el);
}
function setBadge(id, [text, color]) {
  const el = document.getElementById(id);
  if (el) { el.textContent = text; el.className = `badge ${color}`; }
}
function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}
</script>
</body>
</html>
```

---

## Step 2 — Add static file serving to server.js

In `server.js`, find this exact line:
```
app.use(express.json());
```

Add `app.use(express.static(__dirname));` on the line immediately after it, so it reads:
```js
app.use(express.json());
app.use(express.static(__dirname));
```

---

## Step 3 — Add the /api/admin/status route to server.js

In `server.js`, find this exact line:
```
app.get("/admin", async (req, res) => {
```

Insert the following block of code **immediately before** that line (do not replace it yet — just insert before):

```js
// ─────────────────────────────────────────────────────────────────────────────
// ADMIN STATUS ENDPOINT — add this to server.js
//
// WHAT CHANGED: Replaces the massive inline HTML admin dashboard with a clean
// JSON endpoint that admin.html fetches on load.
//
// WHERE TO PASTE: Replace the entire `app.get("/admin", ...)` block in server.js
// with the TWO routes below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/status
 * Returns all admin dashboard data as JSON.
 * Called by admin.html on load — no more server-side template rendering.
 */
app.get("/api/admin/status", async (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Fetch all stats in parallel
  const [oddsQuota, dbStats] = await Promise.allSettled([
    fetchQuota(),
    (async () => {
      const usersRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?select=count`, {
        headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`, Prefer: 'count=exact' }
      });
      const betsRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bets?select=count`, {
        headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`, Prefer: 'count=exact' }
      });
      return {
        users: usersRes.headers.get('content-range')?.split('/')[1] || '0',
        bets: betsRes.headers.get('content-range')?.split('/')[1] || '0',
      };
    })(),
  ]);

  const quota = oddsQuota.status === 'fulfilled' ? oddsQuota.value : { remaining: 'N/A', used: 'N/A' };
  const db = dbStats.status === 'fulfilled' ? dbStats.value : { users: 0, bets: 0 };

  const { lastRefresh, nextRefresh } = getScheduledTimes();
  const cacheAgeMs = cache.picks.fetchedAt ? Date.now() - cache.picks.fetchedAt : null;

  const openingDay = new Date('2026-03-25T16:05:00-04:00');
  const now = new Date();
  const seasonStarted = now >= openingDay;
  const daysUntilOpening = Math.ceil((openingDay - now) / (1000 * 60 * 60 * 24));

  res.json({
    timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    uptime: Math.floor(process.uptime() / 60),
    nodeVersion: process.version,
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),

    quota: {
      remaining: quota.remaining,
      used: quota.used,
      limit: 500,
    },

    db: {
      users: db.users,
      bets: db.bets,
      provider: 'Supabase',
    },

    agent: {
      status: agentAutoRun.status,
      lastRun: agentAutoRun.lastRunTime || null,
      lastRunDate: agentAutoRun.lastRun || null,
      freeModel: 'claude-sonnet',
      premiumModel: 'claude-opus',
    },

    cache: {
      isValid: isCacheValid(cache.picks),
      hasData: !!cache.picks.data,
      fetchedAt: cache.picks.fetchedAt ? new Date(cache.picks.fetchedAt).toISOString() : null,
      ageMinutes: cacheAgeMs !== null ? Math.floor(cacheAgeMs / 60000) : null,
      picksCount: cache.picks.data?.total || 0,
      gamesAnalyzed: cache.picks.data?.gamesAnalyzed || 0,
      bypass: CACHE_BYPASS,
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
      nextRefresh: nextRefresh ? nextRefresh.toISOString() : null,
    },

    season: {
      started: seasonStarted,
      openingDay: '2026-03-25',
      daysUntilOpening: seasonStarted ? 0 : daysUntilOpening,
      dataSource: seasonStarted ? 'Live (Supabase)' : 'Projections (pre-season)',
    },

    sharpMoney: {
      oddsApiUpgraded: ODDS_API_UPGRADED,
      booksTracked: ODDS_API_UPGRADED ? ['Pinnacle', 'Circa', 'Bookmaker'] : ['Pinnacle'],
      steamThreshold: 8,
      significantThreshold: 5,
    },

    split: {
      prizePoolEnabled: PRIZE_POOL_ENABLED,
      active: PRIZE_POOL_ENABLED
        ? { operations: 70, prizePool: 20, treasury: 10 }
        : {
            operations: Math.round(SPLIT_CONFIG.operations * 100),
            prizePool: Math.round(SPLIT_CONFIG.prizePool * 100),
            treasury: Math.round(SPLIT_CONFIG.treasury * 100),
          },
      wallets: {
        operations: OPERATIONS_WALLET,
        prizePool: PRIZE_POOL_WALLET,
        revenue: REVENUE_WALLET,
      },
    },
  });
});

/**
 * GET /admin
 * Serves the standalone admin.html file.
 * The HTML page fetches /api/admin/status on load for all dynamic data.
 */
app.get("/admin", (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).send(`
      <html><body style="background:#080B10;color:#FF3A5C;font-family:monospace;padding:40px;text-align:center">
        <h1>⛔ UNAUTHORIZED</h1><p>Invalid admin secret.</p>
      </body></html>
    `);
  }
  // Pass secret to the page via a safe meta tag — admin.html reads it from there
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="admin-secret" content="${secret}">
  <script>
    // Redirect to admin.html with secret in sessionStorage (not URL)
    sessionStorage.setItem('adminSecret', '${secret}');
    window.location.href = '/admin.html';
  </script>
</head>
</html>`);
});
```

---

## Step 4 — Delete the old /admin route

In `server.js`, find and **delete** the entire old `app.get("/admin", async (req, res) => { ... })` block.

It starts with:
```
app.get("/admin", async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
```

And ends with the closing `});` that comes immediately before this line:
```
/**
 * GET /admin/refresh-agent
```

Delete that entire block. The two new routes you inserted in Step 3 replace it completely.

---

## Step 5 — Verify the changes

Run this command to check for syntax errors:
```bash
node --check server.js && echo "✅ Syntax OK" || echo "❌ Syntax error found"
```

Then confirm:
1. `admin.html` exists in the project root
2. `server.js` contains `app.get("/api/admin/status"` 
3. `server.js` contains `app.use(express.static(__dirname))`
4. `server.js` does NOT contain the string `EDGE SEEKER ADMIN` (the old dashboard title that was in the template literal)

Report the results of each check.

---

## What you must NOT do
- Do not modify any other routes in server.js
- Do not change any environment variable references
- Do not alter the existing `/admin/refresh-agent` route
- Do not rename any files

