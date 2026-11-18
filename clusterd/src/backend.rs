use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackendKind {
    StockLlamaCppV1,
    IkLlamaCppFork,
    TandemCppFork,
}

impl BackendKind {
    pub fn label(&self) -> &'static str {
        match self {
            BackendKind::StockLlamaCppV1 => "stock llama.cpp v1.0.0 (RPC v9)",
            BackendKind::IkLlamaCppFork => "drop-in ik_llama.cpp (fused MoE / MLA)",
            BackendKind::TandemCppFork => "drop-in tandem.cpp (CPU-miss overlap)",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendCapability {
    pub kind: BackendKind,
    pub server_bin: String,
    pub rpc_bin: String,
    pub supports_mtp_nextn: bool,
    pub supports_moe_cpu_offload: bool,
    pub supports_cont_batching: bool,
}

pub trait ComputeBackend {
    fn capability(&self) -> BackendCapability;
}

pub struct AutoDetectedBackend {
    cap: BackendCapability,
}

impl AutoDetectedBackend {
    pub fn detect() -> Self {
        Self::detect_with_preference("auto")
    }

    pub fn detect_with_preference(preference: &str) -> Self {
        let exe_suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
        let ik_bin = format!("bin/ik-llama-server{exe_suffix}");
        let tandem_bin = format!("bin/tandem-server{exe_suffix}");

        if (preference == "ik_llama" || preference == "auto") && Path::new(&ik_bin).is_file() {
            return Self {
                cap: BackendCapability {
                    kind: BackendKind::IkLlamaCppFork,
                    server_bin: ik_bin,
                    rpc_bin: format!("rpc-server{exe_suffix}"),
                    supports_mtp_nextn: true,
                    supports_moe_cpu_offload: true,
                    supports_cont_batching: true,
                },
            };
        }

        if (preference == "tandem" || preference == "auto") && Path::new(&tandem_bin).is_file() {
            return Self {
                cap: BackendCapability {
                    kind: BackendKind::TandemCppFork,
                    server_bin: tandem_bin,
                    rpc_bin: format!("rpc-server{exe_suffix}"),
                    supports_mtp_nextn: true,
                    supports_moe_cpu_offload: true,
                    supports_cont_batching: true,
                },
            };
        }

        Self {
            cap: BackendCapability {
                kind: BackendKind::StockLlamaCppV1,
                server_bin: format!("llama-server{exe_suffix}"),
                rpc_bin: format!("rpc-server{exe_suffix}"),
                supports_mtp_nextn: true,
                supports_moe_cpu_offload: true,
                supports_cont_batching: true,
            },
        }
    }
}

impl ComputeBackend for AutoDetectedBackend {
    fn capability(&self) -> BackendCapability {
        self.cap.clone()
    }
}
