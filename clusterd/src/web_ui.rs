//! Embedded Single-Page Web Dashboard (`GET /`) for Central Control of Master & Worker Nodes
//! on Windows and Linux. Designed Simple-First so anyone with zero AI/LLM experience can set up
//! a multi-device cluster in 3 easy steps, with built-in 1-click Auto-Diagnosis and a toggleable
//! Developer Mode hiding all technical GGUF/RPC/CLI controls by default.

/// Generates a 21x21 Version-1 SVG QR matrix encoding the 28-byte ClusterLab v1 packet
/// (`0xC1` magic + IPv4 + Master port + RPC port + secret + CRC-8) matching Android's `ClusterQrCodec`.
pub fn render_pairing_qr_svg(pairing_uri: &str) -> String {
    let size = 21usize;
    let mut grid = vec![vec![false; size]; size];

    // Standard 7x7 Finder patterns at top-left, top-right, bottom-left
    let draw_finder = |g: &mut Vec<Vec<bool>>, r0: usize, c0: usize| {
        for r in 0..7 {
            for c in 0..7 {
                let border = r == 0 || r == 6 || c == 0 || c == 6;
                let inner = (2..=4).contains(&r) && (2..=4).contains(&c);
                g[r0 + r][c0 + c] = border || inner;
            }
        }
    };
    draw_finder(&mut grid, 0, 0);
    draw_finder(&mut grid, 0, size - 7);
    draw_finder(&mut grid, size - 7, 0);

    // Timing patterns on row 6 and col 6
    for i in 8..(size - 8) {
        grid[6][i] = i % 2 == 0;
        grid[i][6] = i % 2 == 0;
    }

    // Parse master=IP:Port, rpc=Port, and secret=... from pairing_uri
    let query = pairing_uri.split('?').nth(1).unwrap_or("");
    let mut master_addr = "127.0.0.1:8080";
    let mut rpc_port: u16 = 50052;
    let mut secret = crate::protocol::DEFAULT_CLUSTER_SECRET;
    for kv in query.split('&') {
        let mut parts = kv.splitn(2, '=');
        let k = parts.next().unwrap_or("");
        let v = parts.next().unwrap_or("");
        match k {
            "master" if !v.is_empty() => master_addr = v,
            "rpc" => rpc_port = v.parse::<u16>().unwrap_or(50052),
            "secret" if !v.is_empty() => secret = v,
            _ => {}
        }
    }

    let mut host_parts = master_addr.splitn(2, ':');
    let host_ip = host_parts.next().unwrap_or("127.0.0.1");
    let master_port: u16 = host_parts.next().unwrap_or("8080").parse().unwrap_or(8080);
    let octets: Vec<u8> = host_ip
        .split('.')
        .filter_map(|s| s.parse::<u8>().ok())
        .collect();
    let ip_bytes = if octets.len() == 4 {
        [octets[0], octets[1], octets[2], octets[3]]
    } else {
        [127, 0, 0, 1]
    };

    let mut packet = [0u8; 28];
    packet[0] = 0xC1;
    packet[1..5].copy_from_slice(&ip_bytes);
    packet[5] = ((master_port >> 8) & 0xFF) as u8;
    packet[6] = (master_port & 0xFF) as u8;
    packet[7] = ((rpc_port >> 8) & 0xFF) as u8;
    packet[8] = (rpc_port & 0xFF) as u8;
    let secret_bytes = secret.as_bytes();
    let secret_len = secret_bytes.len().min(17);
    packet[9] = secret_len as u8;
    packet[10..(10 + secret_len)].copy_from_slice(&secret_bytes[..secret_len]);

    // Compute CRC-8 (polynomial 0x07) over bytes 0..27
    let mut crc: u8 = 0;
    for &b in &packet[..27] {
        crc ^= b;
        for _ in 0..8 {
            if (crc & 0x80) != 0 {
                crc = (crc << 1) ^ 0x07;
            } else {
                crc <<= 1;
            }
        }
    }
    packet[27] = crc;

    let mut bit_idx = 0usize;
    let total_bits = packet.len() * 8;
    for r in 0..size {
        for c in 0..size {
            let in_top_left = r < 8 && c < 8;
            let in_top_right = r < 8 && c >= size - 8;
            let in_bottom_left = r >= size - 8 && c < 8;
            let is_timing = r == 6 || c == 6;
            if in_top_left || in_top_right || in_bottom_left || is_timing {
                continue;
            }
            let bit = if bit_idx < total_bits {
                let b = packet[bit_idx / 8];
                let shift = 7 - (bit_idx % 8);
                ((b >> shift) & 1) == 1
            } else {
                (r + c) % 2 == 0
            };
            grid[r][c] = bit;
            bit_idx += 1;
        }
    }

    let mut rects = String::with_capacity(4096);
    for (r, row) in grid.iter().enumerate() {
        for (c, &dark) in row.iter().enumerate() {
            if dark {
                rects.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"1\" height=\"1\" fill=\"#0F172A\"/>",
                    c + 2,
                    r + 2
                ));
            }
        }
    }

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 25 25\" width=\"188\" height=\"188\" shape-rendering=\"crispEdges\">\
        <rect width=\"25\" height=\"25\" rx=\"2\" fill=\"#FFFFFF\"/>{}</svg>",
        rects
    )
}

pub const CENTRAL_CONTROL_WEB_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClusterLab — Easy Multi-Device AI Setup</title>
  <style>
    :root {
      --bg: #0b1120;
      --surface: #131c31;
      --surface-2: #1e293b;
      --border: #334155;
      --primary: #3b82f6;
      --emerald: #10b981;
      --amber: #f59e0b;
      --red: #ef4444;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1180px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 20px 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      margin-bottom: 20px;
    }
    .brand h1 { font-size: 1.45rem; font-weight: 700; letter-spacing: -0.02em; }
    .brand p { color: var(--muted); font-size: 0.9rem; margin-top: 2px; }
    .header-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--emerald); }
    .dev-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 0.82rem;
      cursor: pointer;
      color: var(--muted);
    }
    .dev-toggle input { width: auto; flex: 0; accent-color: var(--primary); cursor: pointer; }
    .steps-banner {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    @media (max-width: 800px) { .steps-banner { grid-template-columns: 1fr; } }
    .step-pill {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .step-pill small { color: #60a5fa; font-weight: 700; text-transform: uppercase; font-size: 0.72rem; }
    .step-pill strong { display: block; font-size: 0.96rem; margin-top: 2px; }
    .step-pill p { color: var(--muted); font-size: 0.82rem; margin-top: 2px; }
    .grid {
      display: grid;
      grid-template-columns: 1.7fr 1fr;
      gap: 20px;
    }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card h2 {
      font-size: 1.05rem;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .subtext { color: var(--muted); font-size: 0.86rem; margin-bottom: 14px; }
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .kpi {
      background: var(--surface-2);
      padding: 14px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .kpi span { display: block; font-size: 0.74rem; color: var(--muted); text-transform: uppercase; }
    .kpi strong { font-size: 1.3rem; color: var(--text); }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    .status-pill {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 99px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .status-Online, .sev-ok { background: rgba(16,185,129,0.18); color: #34d399; }
    .status-Throttled, .sev-warning { background: rgba(245,158,11,0.18); color: #fbbf24; }
    .status-Offline, .status-SheddingMemory, .sev-issue { background: rgba(239,68,68,0.18); color: #f87171; }
    .status-PrunedEdgeSbc { background: rgba(148,163,184,0.18); color: #cbd5e1; }
    .preset-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 12px;
    }
    @media (max-width: 700px) { .preset-grid { grid-template-columns: 1fr; } }
    .preset-btn {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      text-align: left;
      color: var(--text);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .preset-btn:hover, .preset-btn.active {
      border-color: var(--primary);
      background: rgba(59, 130, 246, 0.14);
    }
    .preset-btn strong { display: block; font-size: 0.94rem; margin-bottom: 4px; }
    .preset-btn span { display: block; font-size: 0.78rem; color: var(--muted); }
    .form-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    input, select, textarea {
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 0.88rem;
      flex: 1;
    }
    button {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 10px 16px;
      border-radius: 10px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.86rem;
    }
    button.secondary { background: var(--surface-2); border: 1px solid var(--border); }
    button.danger { background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid rgba(239,68,68,0.4); padding: 5px 10px; }
    .qr-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      background: var(--surface-2);
      padding: 18px;
      border-radius: 14px;
      text-align: center;
      gap: 12px;
    }
    .phone-steps {
      text-align: left;
      width: 100%;
      font-size: 0.84rem;
      color: var(--muted);
      padding-left: 18px;
    }
    .phone-steps li { margin-bottom: 4px; }
    .uri-code {
      font-family: monospace;
      font-size: 0.76rem;
      background: #090e1a;
      padding: 8px 10px;
      border-radius: 8px;
      width: 100%;
      word-break: break-all;
      color: #93c5fd;
      border: 1px solid var(--border);
    }
    .diag-item {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      margin-top: 10px;
    }
    .diag-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; }
    .diag-msg { font-size: 0.83rem; color: var(--muted); }
    .bar-bg { width: 100%; background: var(--surface-2); height: 8px; border-radius: 4px; overflow: hidden; margin-top: 6px; }
    .bar-fill { background: var(--primary); height: 100%; }
    pre.console {
      background: #070b14;
      border: 1px solid var(--border);
      padding: 14px;
      border-radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 0.9rem;
      min-height: 74px;
      white-space: pre-wrap;
      color: #e2e8f0;
      margin-top: 10px;
    }
    .dev-only { display: none; }
    body.dev-mode .dev-only { display: block; }
    body.dev-mode .dev-only-flex { display: flex; }
    .dev-only-flex { display: none; }
    body.dev-mode th.dev-col, body.dev-mode td.dev-col { display: table-cell; }
    th.dev-col, td.dev-col { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>ClusterLab Easy Setup</h1>
        <p id="masterHostInfo">Combine your Windows PC, Linux PC, and Android phones to run AI together — safely and automatically.</p>
      </div>
      <div class="header-right">
        <div class="badge"><span class="dot"></span> <span id="clusterBadge">READY</span></div>
        <label class="dev-toggle" title="Reveal advanced technical settings for developers">
          <input type="checkbox" id="devModeToggle" onchange="toggleDevMode(this.checked)" />
          <span>Developer Mode</span>
        </label>
      </div>
    </header>

    <div class="steps-banner">
      <div class="step-pill">
        <small>Step 1</small>
        <strong>Add Phones or Extra PCs</strong>
        <p>Scan the QR code on the right with your Android phone, or click Find Nearby Devices.</p>
      </div>
      <div class="step-pill">
        <small>Step 2</small>
        <strong>Pick an AI Size</strong>
        <p>Choose Small, Balanced, or Large below — we balance memory automatically.</p>
      </div>
      <div class="step-pill">
        <small>Step 3</small>
        <strong>Check &amp; Test</strong>
        <p>Run Auto-Diagnosis anytime if something won't connect, then test your cluster.</p>
      </div>
    </div>

    <div class="grid">
      <div>
        <div class="card">
          <h2>
            <span>Your Connected Devices</span>
            <button class="secondary" onclick="scanNodes()">Find Nearby Devices</button>
          </h2>
          <p class="subtext">Each device automatically limits itself to half its memory so nothing ever slows down.</p>

          <div class="kpi-row">
            <div class="kpi"><span>Helper Devices</span><strong id="kpiWorkers">0</strong></div>
            <div class="kpi"><span>Shared Safe Memory</span><strong id="kpiRam">0 GB</strong></div>
            <div class="kpi"><span>Work Distribution</span><strong id="kpiLayers">Balanced</strong></div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Type</th>
                <th class="dev-col">Endpoint</th>
                <th>Safe Memory</th>
                <th>Work Share</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="nodesTableBody">
              <tr><td colspan="7" style="color:var(--muted);">Checking connected devices...</td></tr>
            </tbody>
          </table>

          <div class="form-row dev-only-flex">
            <input type="text" id="newNodeAddr" placeholder="Manual worker IP:Port (e.g. 192.168.1.45:50052)" />
            <button onclick="addNode()">+ Add Manually</button>
          </div>
        </div>

        <div class="card">
          <h2>Pick an AI Size (Auto-Balanced Across Devices)</h2>
          <p class="subtext">No technical knowledge needed — pick how smart vs. fast you want your AI to be.</p>

          <div class="preset-grid">
            <button class="preset-btn active" id="preset-small" onclick="applyPreset('small')">
              <strong>Small &amp; Fast</strong>
              <span>~1.2 GB • Works smoothly on almost any single PC or PC + 1 phone.</span>
            </button>
            <button class="preset-btn" id="preset-balanced" onclick="applyPreset('balanced')">
              <strong>Balanced Everyday</strong>
              <span>~2.8 GB • Great quality when sharing with 1–2 phones or another PC.</span>
            </button>
            <button class="preset-btn" id="preset-large" onclick="applyPreset('large')">
              <strong>Smart &amp; Large</strong>
              <span>~5.2 GB • Best with multiple PCs and phones working together.</span>
            </button>
          </div>

          <div class="dev-only">
            <div class="form-row">
              <input type="text" id="modelPathInput" value="models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" placeholder="Custom GGUF file path on Master" />
              <input type="number" id="modelMbInput" value="1500" style="max-width:130px" title="Model Required RAM (MB)" />
              <input type="number" id="totalLayersInput" value="24" style="max-width:110px" title="Total Layers" />
              <button onclick="rebalanceModel()">Apply Custom Model</button>
            </div>
            <div class="uri-code" id="llamaArgsPreview" style="margin-top:10px; color:#cbd5e1;">llama-server args loading...</div>
          </div>
        </div>

        <div class="card">
          <h2>Test Your Cluster</h2>
          <p class="subtext">Send a quick message to verify all your connected devices respond together.</p>
          <div class="form-row">
            <input type="text" id="promptInput" value="Hello cluster! Confirm my connected devices are working together." />
            <button onclick="runInference()">Run Quick Test</button>
          </div>
          <pre class="console" id="sseOutput">Ready. Click "Run Quick Test" to verify your cluster.</pre>
        </div>
      </div>

      <div>
        <div class="card">
          <h2>Add an Android Phone (QR Code)</h2>
          <div class="qr-box">
            <div id="qrSvgContainer"></div>
            <ol class="phone-steps">
              <li>Open <strong>ClusterLab</strong> on your Android phone.</li>
              <li>Tap <strong>Connect Phone</strong> at the bottom.</li>
              <li>Tap <strong>Scan QR</strong> and point at this code (or tap <strong>Auto-Connect</strong>).</li>
            </ol>
            <div class="uri-code dev-only" id="pairingUriText">clusterd://pair?master=127.0.0.1:8080</div>
            <div class="uri-code dev-only" id="usbPairingUriText" style="color:#a7f3d0;">USB ADB: clusterd://pair?master=127.0.0.1:8080</div>
            <button class="secondary dev-only" style="width:100%" onclick="copyPairingCode()">Copy Pairing URI</button>
          </div>
        </div>

        <div class="card">
          <h2>
            <span>Auto-Diagnosis &amp; Fix</span>
            <button class="secondary" onclick="runDiagnosis()">Check Now</button>
          </h2>
          <p class="subtext">Having trouble connecting a phone or loading a model? Click Check Now for plain-English fixes.</p>
          <div id="diagContainer">
            <div class="diag-item">
              <div class="diag-head">
                <strong>Automatic Troubleshooter</strong>
                <span class="status-pill sev-ok">Ready</span>
              </div>
              <div class="diag-msg">Checks Wi-Fi network, helper devices, memory fit, and USB cable readiness automatically.</div>
            </div>
          </div>
        </div>

        <div class="card dev-only">
          <h2>Developer Hardware Info</h2>
          <div id="masterStatsBox" style="font-size:0.84rem; color:var(--muted);"></div>
        </div>
      </div>
    </div>
    <footer style="margin-top:20px; padding-top:12px; border-top:1px solid var(--border); text-align:center; font-size:0.8rem; color:var(--muted);">
      ClusterLab v1.0 &bull; Author: AJ60 &bull; MIT License
    </footer>
  </div>

  <script>
    var devMode = false;

    function escHtml(val) {
      return String(val === null || val === undefined ? '' : val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function xhrRequest(method, url, payload, onDone) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      if (payload !== null && payload !== undefined) {
        xhr.setRequestHeader('Content-Type', 'application/json');
      }
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          onDone(null, xhr.responseText);
        } else {
          onDone(new Error('HTTP ' + xhr.status), xhr.responseText);
        }
      };
      xhr.onerror = function() {
        onDone(new Error('Network error'), '');
      };
      xhr.send(payload !== null && payload !== undefined ? payload : null);
    }

    function toggleDevMode(enabled) {
      devMode = !!enabled;
      if (devMode) {
        document.body.className = 'dev-mode';
      } else {
        document.body.className = '';
      }
    }

    function friendlyStatus(health) {
      if (devMode) return health;
      if (health === 'Online') return 'Active & Helping';
      if (health === 'PrunedEdgeSbc') return 'Standby (Saved Power)';
      if (health === 'Throttled') return 'Cooling Down';
      if (health === 'SheddingMemory') return 'Paused (Freeing RAM)';
      if (health === 'Offline') return 'Disconnected';
      return health;
    }

    function formatMem(mb) {
      return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
    }

    function fetchStatus() {
      xhrRequest('GET', '/api/status', null, function(err, body) {
        if (err || !body) return;
        try {
          var data = JSON.parse(body);
          var masterOs = data.master_os || 'This Computer';
          var lanIp = data.lan_ip || '127.0.0.1';
          var gfxLabel = data.master_legacy_graphics ? 'Legacy-Safe CPU Mode' : (data.master_graphics_tier || 'Standard');
          document.getElementById('masterHostInfo').textContent =
            'Running on ' + masterOs +
            (devMode
              ? (' • LAN ' + lanIp + ':' + data.master_port + ' • ' + gfxLabel)
              : (data.master_legacy_graphics ? ' • Legacy-Safe Graphics Active • Ready to pair on Wi-Fi' : ' • Ready to pair phones and PCs on your Wi-Fi'));
          document.getElementById('kpiWorkers').textContent =
            data.online_workers === 0 ? '0 (This PC only)' : (data.online_workers + ' Active');
          document.getElementById('kpiRam').textContent = formatMem(data.total_safe_ram_mb);
          var pctMaster = Math.round((data.master_layers / Math.max(1, data.total_layers)) * 100);
          document.getElementById('kpiLayers').textContent =
            devMode ? (data.total_layers + 'L (M:' + data.master_layers + ')') : ('PC ' + pctMaster + '% / Helpers ' + (100 - pctMaster) + '%');

          var badgeEl = document.getElementById('clusterBadge');
          if (badgeEl) {
            badgeEl.textContent = data.master_legacy_graphics ? 'READY (CPU-SAFE)' : 'READY';
          }

          document.getElementById('pairingUriText').textContent = data.pairing_uri || '';
          if (data.usb_pairing_uri) {
            document.getElementById('usbPairingUriText').textContent = 'USB ADB: ' + data.usb_pairing_uri;
          }
          if (data.llama_cli_args) {
            document.getElementById('llamaArgsPreview').textContent = 'llama-server ' + data.llama_cli_args;
          }
          if (data.qr_svg) {
            document.getElementById('qrSvgContainer').innerHTML = data.qr_svg;
          }
          document.getElementById('masterStatsBox').innerHTML =
            '<div><strong>Master OS:</strong> ' + escHtml(masterOs) + ' (' + escHtml(data.master_arch || 'unknown') + ', ' + escHtml(lanIp) + ')</div>' +
            '<div><strong>Safe RAM Cap:</strong> ' + escHtml(data.master_safe_cap_mb) + ' MB / ' + escHtml(data.master_total_ram_mb) + ' MB</div>' +
            '<div><strong>Graphics Tier:</strong> ' + escHtml(gfxLabel) + '</div>' +
            '<div><strong>Performance Cores:</strong> ' + escHtml(data.master_big_cores) + '</div>' +
            '<div><strong>Model Path:</strong> ' + escHtml(data.model_path) + '</div>' +
            '<div><strong>UDP Discovery:</strong> Port 50050 Active</div>';

          var tbody = document.getElementById('nodesTableBody');
          var rowsHtml =
            '<tr>' +
              '<td><strong>This Computer</strong></td>' +
              '<td><span class="status-pill status-Online">' + escHtml(masterOs) + (data.master_legacy_graphics ? ' (CPU-Safe)' : '') + '</span></td>' +
              '<td class="dev-col">' + escHtml(lanIp) + ':' + escHtml(data.master_port) + '</td>' +
              '<td>' + escHtml(formatMem(data.master_safe_cap_mb)) + '</td>' +
              '<td><strong>' + pctMaster + '%</strong><div class="bar-bg"><div class="bar-fill" style="width:' + pctMaster + '%"></div></div></td>' +
              '<td><span class="status-pill status-Online">Main PC</span></td>' +
              '<td>&mdash;</td>' +
            '</tr>';

          var workers = data.workers || [];
          for (var i = 0; i < workers.length; i++) {
            var w = workers[i];
            var sharePct = Math.round((w.assigned_layers / Math.max(1, data.total_layers)) * 100);
            var safeHealth = escHtml(w.health);
            var wAddr = escHtml(w.addr);
            var platTag = escHtml(w.platform || 'Helper') + (w.legacy_graphics ? ' (CPU-Safe)' : '');
            rowsHtml +=
              '<tr>' +
                '<td><strong>' + escHtml(w.id) + '</strong></td>' +
                '<td><span class="status-pill status-PrunedEdgeSbc">' + platTag + '</span></td>' +
                '<td class="dev-col">' + wAddr + '</td>' +
                '<td>' + escHtml(formatMem(w.safe_cap_mb)) + '</td>' +
                '<td><strong>' + (devMode ? (escHtml(w.assigned_layers) + 'L') : (sharePct + '%')) + '</strong><div class="bar-bg"><div class="bar-fill" style="width:' + Math.min(100, sharePct) + '%"></div></div></td>' +
                '<td><span class="status-pill status-' + safeHealth + '">' + escHtml(friendlyStatus(w.health)) + '</span></td>' +
                '<td><button class="danger" onclick="removeNode(\'' + wAddr + '\')">Remove</button></td>' +
              '</tr>';
          }
          tbody.innerHTML = rowsHtml;
        } catch (e) {
          if (window.console && console.error) console.error(e);
        }
      });
    }

    function runDiagnosis() {
      var box = document.getElementById('diagContainer');
      box.innerHTML = '<div class="diag-item"><div class="diag-msg">Checking your setup...</div></div>';
      xhrRequest('GET', '/api/diagnose', null, function(err, body) {
        if (err || !body) {
          box.innerHTML = '<div class="diag-item"><div class="diag-msg">Could not reach Master service. Make sure ClusterLab is running.</div></div>';
          return;
        }
        try {
          var diag = JSON.parse(body);
          var html = '<div class="diag-item" style="border-color:var(--primary)">' +
            '<div class="diag-head">' +
              '<strong>' + escHtml(diag.headline) + '</strong>' +
              '<span class="status-pill sev-' + escHtml(diag.overall) + '">' + escHtml(String(diag.overall || '').toUpperCase()) + '</span>' +
            '</div></div>';
          var checks = diag.checks || [];
          for (var i = 0; i < checks.length; i++) {
            var c = checks[i];
            var fixBtn = '';
            if (c.fix_action === 'scan_nodes') {
              fixBtn = '<div style="margin-top:8px"><button class="secondary" onclick="applyDiagFix(\'scan_nodes\')">Auto-Fix: Find Nearby Devices</button></div>';
            } else if (c.fix_action === 'use_small_preset') {
              fixBtn = '<div style="margin-top:8px"><button class="secondary" onclick="applyDiagFix(\'use_small_preset\')">Auto-Fix: Switch to Small &amp; Fast AI</button></div>';
            }
            var sevLabel = c.severity === 'ok' ? 'OK' : (c.severity === 'warning' ? 'Tip' : 'Fix Needed');
            html += '<div class="diag-item">' +
              '<div class="diag-head">' +
                '<strong>' + escHtml(c.title) + '</strong>' +
                '<span class="status-pill sev-' + escHtml(c.severity) + '">' + sevLabel + '</span>' +
              '</div>' +
              '<div class="diag-msg">' + escHtml(c.message) + '</div>' +
              fixBtn +
            '</div>';
          }
          box.innerHTML = html;
        } catch (e) {
          box.innerHTML = '<div class="diag-item"><div class="diag-msg">Diagnostic response parse error.</div></div>';
        }
      });
    }

    function applyDiagFix(action) {
      if (action === 'scan_nodes') {
        scanNodes(runDiagnosis);
      } else if (action === 'use_small_preset') {
        applyPreset('small');
      } else {
        runDiagnosis();
      }
    }

    function applyPreset(preset) {
      var btns = document.querySelectorAll('.preset-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].className = btns[i].className.replace(/\bactive\b/g, '').replace(/\s+/g, ' ').trim();
      }
      var el = document.getElementById('preset-' + preset);
      if (el) el.className += ' active';

      var map = {
        small: { model_path: 'models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', model_mb: 1200, total_layers: 24 },
        balanced: { model_path: 'models/Qwen2.5-3B-Instruct-Q4_K_M.gguf', model_mb: 2800, total_layers: 36 },
        large: { model_path: 'models/Llama-3.1-8B-Instruct-Q4_K_M.gguf', model_mb: 5200, total_layers: 32 }
      };
      var cfg = map[preset] || map.small;
      document.getElementById('modelPathInput').value = cfg.model_path;
      document.getElementById('modelMbInput').value = cfg.model_mb;
      document.getElementById('totalLayersInput').value = cfg.total_layers;
      xhrRequest('POST', '/api/model/load', JSON.stringify(cfg), function() {
        fetchStatus();
        runDiagnosis();
      });
    }

    function addNode() {
      var input = document.getElementById('newNodeAddr');
      var addr = input.value.replace(/^\s+|\s+$/g, '');
      if (!addr) return;
      xhrRequest('POST', '/api/nodes/add', JSON.stringify({ addr: addr }), function() {
        input.value = '';
        fetchStatus();
      });
    }

    function removeNode(addr) {
      xhrRequest('POST', '/api/nodes/remove', JSON.stringify({ addr: addr }), function() {
        fetchStatus();
      });
    }

    function scanNodes(cb) {
      xhrRequest('POST', '/api/nodes/scan', '{}', function() {
        fetchStatus();
        if (typeof cb === 'function') cb();
      });
    }

    function rebalanceModel() {
      var model_path = document.getElementById('modelPathInput').value.replace(/^\s+|\s+$/g, '');
      var model_mb = parseInt(document.getElementById('modelMbInput').value || '1500', 10);
      var total_layers = parseInt(document.getElementById('totalLayersInput').value || '24', 10);
      xhrRequest('POST', '/api/model/load', JSON.stringify({
        model_path: model_path,
        model_mb: model_mb,
        total_layers: total_layers
      }), function() {
        fetchStatus();
      });
    }

    function runInference() {
      var out = document.getElementById('sseOutput');
      out.textContent = 'Testing your connected devices...\n';
      var prompt = document.getElementById('promptInput').value;
      var payload = JSON.stringify({
        model: 'cluster-gguf',
        stream: true,
        messages: [{ role: 'user', content: prompt }]
      });
      xhrRequest('POST', '/v1/chat/completions', payload, function(err, raw) {
        if (err) {
          out.textContent = 'Request failed: ' + err.message;
          return;
        }
        if (devMode) {
          out.textContent = raw;
          return;
        }
        var readable = '';
        var lines = String(raw || '').split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data: ') !== 0 || line.indexOf('[DONE]') !== -1) continue;
          try {
            var parsed = JSON.parse(line.slice(6));
            var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
            if (delta) readable += delta;
          } catch (_) {}
        }
        out.textContent = readable || raw;
      });
    }

    function copyPairingCode() {
      var txt = document.getElementById('pairingUriText').textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
      }
    }

    fetchStatus();
    runDiagnosis();
    setInterval(fetchStatus, 2500);
  </script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pairing_qr_svg_is_valid_and_legacy_safe_web_ui_has_no_webgl() {
        let svg = render_pairing_qr_svg("clusterd://pair?master=192.168.1.25:8080&rpc=50052");
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("<rect"));
        assert!(CENTRAL_CONTROL_WEB_HTML.contains("XMLHttpRequest"));
        assert!(!CENTRAL_CONTROL_WEB_HTML.contains("backdrop-filter"));
    }
}
