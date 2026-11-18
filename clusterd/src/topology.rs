use crate::hw_probe::log_event;
use crate::tier_planner::{NodeStatus, SpokeTelemetry};
use std::collections::HashMap;

fn link_priority(link_type: &str) -> u8 {
    match link_type {
        "local" | "loopback" => 5,
        "adb_usb" => 4,
        "usb_rndis" => 3,
        "wifi_hotspot" => 2,
        "wifi_lan" => 1,
        _ => 0,
    }
}

/// Deduplicates peers by node_id so fast USB (adb_usb / usb_rndis) always overrides
/// duplicate Wi-Fi discoveries for the exact same phone/spoke.
pub fn deduplicate_by_link_priority(nodes: Vec<SpokeTelemetry>) -> Vec<SpokeTelemetry> {
    let mut best: HashMap<String, SpokeTelemetry> = HashMap::new();
    for node in nodes {
        match best.get(&node.node_id) {
            Some(existing) if link_priority(&existing.link_type) > link_priority(&node.link_type) => {}
            _ => {
                best.insert(node.node_id.clone(), node);
            }
        }
    }
    let mut out: Vec<SpokeTelemetry> = best.into_values().collect();
    out.sort_by(|a, b| b.is_master.cmp(&a.is_master).then_with(|| a.node_id.cmp(&b.node_id)));
    out
}

/// Petals / Parallax Drop-Resilient Re-Router:
/// Transitions disconnected (>6s missed heartbeat) or thermally throttled spokes to Offline.
/// Returns true if any state changed and rebalance is required.
pub fn check_drop_resilient_health(
    nodes: &mut [SpokeTelemetry],
    now_epoch_s: u64,
    thermal_threshold: f64,
    max_pkt_loss_pct: f64,
) -> bool {
    let mut changed = false;
    for n in nodes.iter_mut() {
        if n.is_master {
            n.last_seen_epoch_s = now_epoch_s;
            continue;
        }
        if n.status == NodeStatus::Connected {
            let age = now_epoch_s.saturating_sub(n.last_seen_epoch_s);
            if age > 6 {
                n.status = NodeStatus::Offline;
                n.handshake_ok = false;
                changed = true;
                log_event(
                    "WARNING",
                    &n.node_id,
                    "TOPOLOGY",
                    "HEARTBEAT_TIMEOUT",
                    "Missed >6s heartbeat; dropping spoke to OFFLINE for rebalance",
                    &format!("age_s={age}"),
                );
            } else if n.thermal_headroom >= thermal_threshold {
                n.status = NodeStatus::Offline;
                changed = true;
                log_event(
                    "WARNING",
                    &n.node_id,
                    "TOPOLOGY",
                    "ADPF_THERMAL_THROTTLE",
                    "Thermal headroom exceeded threshold; dropping spoke cleanly",
                    &format!("headroom={:.2}", n.thermal_headroom),
                );
            } else if n.pkt_loss_pct > max_pkt_loss_pct {
                changed = true;
                log_event(
                    "WARNING",
                    &n.node_id,
                    "TOPOLOGY",
                    "LOSSY_LINK",
                    "Packet loss exceeded threshold; scheduler will prune layers",
                    &format!("pkt_loss={:.1}%", n.pkt_loss_pct),
                );
            }
        }
    }
    changed
}

/// Detects symmetric 2^n homogeneous Gigabit LAN clusters eligible for Distributed Llama TP.
pub fn is_symmetric_lan_tp_eligible(nodes: &[SpokeTelemetry]) -> bool {
    let online: Vec<&SpokeTelemetry> = nodes
        .iter()
        .filter(|n| n.status == NodeStatus::Connected && n.handshake_ok)
        .collect();
    let count = online.len();
    if count < 2 || !count.is_power_of_two() {
        return false;
    }
    if online.iter().any(|n| n.is_android) {
        return false;
    }
    let first_ram = online[0].ram_total_mb;
    let first_tflops = online[0].compute_tflops;
    online.iter().all(|n| {
        n.bandwidth_mbps >= 900.0
            && (n.ram_total_mb as i64 - first_ram as i64).abs() <= 512
            && (n.compute_tflops - first_tflops).abs() <= 0.5
    })
}
