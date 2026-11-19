# frozen_string_literal: true

# ClusterLab Lightweight Zero-WebGL Web Dashboard
# Author: AJ60 (MIT License)
#
# Engineered to survive legacy graphics drivers, software renderers (llvmpipe,
# Microsoft Basic Display Adapter, Intel GMA/HD 2000-4000, Mali-400), and older
# browsers: zero WebGL, zero CSS backdrop-filter/blur, zero heavy animations,
# and pure ES5-compatible JavaScript.

require_relative "protocol"

module ClusterLab
  module WebUI
    module_function

    def render_html(lan_ip:, http_port:, rpc_port:, secret:, probe_info:)
      qr_svg = Protocol.render_qr_svg(
        master_ip: lan_ip,
        master_port: http_port,
        rpc_port: rpc_port,
        secret: secret
      )
      pair_uri = "clusterd://pair?master=#{lan_ip}:#{http_port}&rpc=#{rpc_port}&secret=#{secret}"
      legacy_badge = probe_info[:legacy_graphics] ? "Legacy-Safe Mode (Zero-WebGL / CPU)" : "Standard Accelerated Mode"

      <<~HTML
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>ClusterLab Control • Pure-Ruby Auto-Cluster</title>
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              padding: 16px;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              background: #0f172a;
              color: #e2e8f0;
              line-height: 1.45;
            }
            .wrap { max-width: 980px; margin: 0 auto; }
            .card {
              background: #1e293b;
              border: 1px solid #334155;
              border-radius: 10px;
              padding: 16px;
              margin-bottom: 14px;
            }
            h1 { margin: 0 0 6px 0; font-size: 20px; color: #f8fafc; }
            h2 { margin: 0 0 10px 0; font-size: 15px; color: #93c5fd; }
            .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
            .pill {
              display: inline-block;
              padding: 4px 10px;
              border-radius: 999px;
              font-size: 12px;
              font-weight: 600;
              background: #0f172a;
              border: 1px solid #475569;
              color: #cbd5e1;
            }
            .pill-ok { border-color: #22c55e; color: #86efac; }
            .pill-warn { border-color: #f59e0b; color: #fde68a; }
            .pill-err { border-color: #ef4444; color: #fca5a5; }
            button {
              background: #2563eb;
              color: #ffffff;
              border: 0;
              border-radius: 8px;
              padding: 10px 14px;
              font-size: 13px;
              font-weight: 600;
              cursor: pointer;
              min-height: 44px;
            }
            button.secondary { background: #334155; color: #e2e8f0; }
            button:hover { opacity: 0.92; }
            input {
              background: #0f172a;
              color: #f8fafc;
              border: 1px solid #475569;
              border-radius: 8px;
              padding: 9px 10px;
              font-size: 13px;
              min-height: 44px;
            }
            table { width: 100%; border-collapse: collapse; font-size: 13px; }
            th, td { text-align: left; padding: 8px; border-bottom: 1px solid #334155; }
            th { color: #94a3b8; font-weight: 600; }
            .qr-box {
              background: #ffffff;
              padding: 8px;
              border-radius: 8px;
              display: inline-block;
            }
            .dev-only { display: none; }
            .dev-on .dev-only { display: block; }
            code {
              background: #0f172a;
              padding: 2px 6px;
              border-radius: 4px;
              font-size: 12px;
              word-break: break-all;
            }
            .muted { color: #94a3b8; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="wrap" id="appRoot">
            <div class="card">
              <div class="row" style="justify-content: space-between;">
                <div>
                  <h1>ClusterLab Pure-Ruby Auto-Cluster</h1>
                  <div class="muted">Zero-Config Mixed-OS Orchestrator • Author: AJ60 • #{legacy_badge}</div>
                </div>
                <div class="row">
                  <button class="secondary" onclick="runDiagnose()">Auto-Diagnose</button>
                  <button class="secondary" onclick="toggleDevMode()" id="devBtn">Developer Mode: OFF</button>
                </div>
              </div>
              <div class="row" style="margin-top: 10px;">
                <span class="pill pill-ok" id="poolBadge">Loading cluster status...</span>
                <span class="pill" id="masterBadge">Master: #{lan_ip}:#{http_port}</span>
                <span class="pill">UDP Auto-Discovery :#{Protocol::DISCOVERY_UDP_PORT}</span>
              </div>
            </div>

            <div class="card">
              <h2>Connected Mixed-Device Nodes (Auto-Scaled)</h2>
              <div class="muted" style="margin-bottom: 10px;">
                Start any other PC, Raspberry Pi, or legacy laptop with <code>ruby clusterd_ruby/bin/clusterd auto</code> — it joins automatically.
                Android devices join via 1-Tap Wi-Fi Scan or the QR code below.
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Platform</th>
                    <th>Health</th>
                    <th>Safe RAM</th>
                    <th>Cores</th>
                    <th>Layers</th>
                    <th>Guard Mode</th>
                  </tr>
                </thead>
                <tbody id="nodesBody">
                  <tr><td colspan="7" class="muted">Waiting for nodes...</td></tr>
                </tbody>
              </table>
            </div>

            <div class="card">
              <h2>1-Tap Android &amp; Mixed-Node Pairing</h2>
              <div class="row">
                <div class="qr-box">#{qr_svg}</div>
                <div style="flex: 1; min-width: 240px;">
                  <p style="margin-top: 0;">Scan with the ClusterLab Android app, or run on any machine with Ruby:</p>
                  <p><code>ruby clusterd_ruby/bin/clusterd auto</code></p>
                  <p class="muted">Manual pairing URI: <code>#{pair_uri}</code></p>
                </div>
              </div>
            </div>

            <div class="card" id="diagCard" style="display: none;">
              <h2>Cluster Auto-Diagnosis</h2>
              <div id="diagBody" class="muted"></div>
            </div>

            <div class="card dev-only">
              <h2>Developer Controls (Manual Node &amp; Model Rebalance)</h2>
              <div class="row" style="margin-bottom: 10px;">
                <input type="text" id="nodeAddrInput" placeholder="192.168.1.50:50052" style="flex: 1; min-width: 180px;">
                <button onclick="addNodeManual()">Add Worker Node</button>
              </div>
              <div class="row">
                <input type="text" id="modelPathInput" placeholder="models/qwen2.5-3b-q4_k_m.gguf" style="flex: 1; min-width: 180px;">
                <input type="number" id="modelMbInput" value="4000" style="width: 110px;" title="Model MB">
                <input type="number" id="modelLayersInput" value="32" style="width: 90px;" title="Layers">
                <button onclick="planModel()">Rebalance Layers</button>
              </div>
              <p class="muted" id="devOutput"></p>
            </div>
          </div>

          <script>
            var devEnabled = false;
            function toggleDevMode() {
              devEnabled = !devEnabled;
              var root = document.getElementById("appRoot");
              var btn = document.getElementById("devBtn");
              root.className = devEnabled ? "wrap dev-on" : "wrap";
              btn.innerHTML = devEnabled ? "Developer Mode: ON" : "Developer Mode: OFF";
            }

            function fetchJson(method, url, payload, cb) {
              var xhr = new XMLHttpRequest();
              xhr.open(method, url, true);
              if (payload) {
                xhr.setRequestHeader("Content-Type", "application/json");
              }
              xhr.onreadystatechange = function() {
                if (xhr.readyState === 4) {
                  try {
                    cb(null, JSON.parse(xhr.responseText));
                  } catch (e) {
                    cb(e, null);
                  }
                }
              };
              xhr.send(payload ? JSON.stringify(payload) : null);
            }

            function renderStatus(data) {
              if (!data) return;
              var pool = document.getElementById("poolBadge");
              pool.innerHTML = "Online Workers: " + data.online_workers + "/" + data.total_workers +
                " • Total Safe RAM: " + data.total_pool_mb + " MB • Master Layers: " + data.master_layers;

              var body = document.getElementById("nodesBody");
              if (!data.nodes || data.nodes.length === 0) {
                body.innerHTML = '<tr><td colspan="7" class="muted">Master running solo. Start another device with <code>clusterd auto</code> to scale out automatically.</td></tr>';
                return;
              }
              var html = "";
              for (var i = 0; i < data.nodes.length; i++) {
                var n = data.nodes[i];
                var cls = n.health === "Online" ? "pill-ok" : (n.health === "Offline" ? "pill-err" : "pill-warn");
                var guard = n.is_legacy_graphics ? "Legacy-Safe CPU" : (n.is_edge_sbc_a72 ? "Edge SBC Guard" : "Standard");
                html += "<tr>" +
                  "<td><code>" + n.addr + "</code></td>" +
                  "<td>" + n.platform + "</td>" +
                  "<td><span class='pill " + cls + "'>" + n.health + "</span></td>" +
                  "<td>" + n.safe_cap_mb + " MB</td>" +
                  "<td>" + n.big_cores + "</td>" +
                  "<td><strong>" + n.assigned_layers + "</strong></td>" +
                  "<td>" + guard + "</td>" +
                  "</tr>";
              }
              body.innerHTML = html;
            }

            function refreshStatus() {
              fetchJson("GET", "/api/status", null, function(err, data) {
                if (!err) renderStatus(data);
              });
            }

            function runDiagnose() {
              fetchJson("GET", "/api/diagnose", null, function(err, data) {
                var card = document.getElementById("diagCard");
                var body = document.getElementById("diagBody");
                card.style.display = "block";
                if (err || !data) {
                  body.innerHTML = "Unable to run diagnosis.";
                  return;
                }
                var lines = "<p><strong>" + data.headline + "</strong></p><ul>";
                for (var i = 0; i < data.checks.length; i++) {
                  var c = data.checks[i];
                  lines += "<li><strong>[" + c.severity + "] " + c.title + ":</strong> " + c.detail + "</li>";
                }
                lines += "</ul>";
                body.innerHTML = lines;
              });
            }

            function addNodeManual() {
              var addr = document.getElementById("nodeAddrInput").value;
              if (!addr) return;
              fetchJson("POST", "/api/nodes/add", { addr: addr }, function(err, data) {
                document.getElementById("devOutput").innerHTML = err ? "Failed to add node." : ("Added " + addr + " -> " + (data.health || "OK"));
                refreshStatus();
              });
            }

            function planModel() {
              var path = document.getElementById("modelPathInput").value || "model.gguf";
              var mb = parseInt(document.getElementById("modelMbInput").value || "4000", 10);
              var layers = parseInt(document.getElementById("modelLayersInput").value || "32", 10);
              fetchJson("POST", "/api/model/load", { model_path: path, model_mb: mb, total_layers: layers }, function(err, data) {
                document.getElementById("devOutput").innerHTML = err ? "Rebalance error." : ("Planned tensor split: " + (data.tensor_split || "local"));
                refreshStatus();
              });
            }

            refreshStatus();
            setInterval(refreshStatus, 2500);
          </script>
        </body>
        </html>
      HTML
    end
  end
end
