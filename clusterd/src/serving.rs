use std::collections::HashMap;
use std::process::{Child, Command, Stdio};

/// Pure-Rust Radix Prefix Tree Router:
/// Hashes system/RAG prompt prefixes to keep warm llama-server KV cache `id_slot`s aligned.
pub struct RadixPrefixRouter {
    slot_hashes: HashMap<u64, u32>,
    next_slot: u32,
    max_slots: u32,
}

impl RadixPrefixRouter {
    pub fn new(max_slots: u32) -> Self {
        Self {
            slot_hashes: HashMap::new(),
            next_slot: 0,
            max_slots: max_slots.max(1),
        }
    }

    pub fn route_slot(&mut self, prefix_text: &str) -> u32 {
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in prefix_text.as_bytes().iter().take(1024) {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        if let Some(&slot) = self.slot_hashes.get(&hash) {
            return slot;
        }
        let slot = self.next_slot % self.max_slots;
        self.next_slot = self.next_slot.wrapping_add(1);
        self.slot_hashes.insert(hash, slot);
        slot
    }
}

/// Pre-request Context Overflow Guard estimating prompt token count cleanly (~3.6 chars/token).
pub fn estimate_prompt_tokens(body_text: &str) -> u32 {
    ((body_text.len() as f64) / 3.6).ceil() as u32
}

pub fn check_context_budget(prompt_tokens: u32, auto_ctx_size: u32) -> Option<String> {
    if prompt_tokens > (auto_ctx_size * 90) / 100 {
        Some(format!(
            "Prompt estimate ({prompt_tokens} toks) approaches/exceeds auto_ctx_size ({auto_ctx_size})"
        ))
    } else {
        None
    }
}

pub fn spawn_llama_server(
    server_bin: &str,
    model_path: &str,
    flags: &[String],
    rpc_arg: &str,
    tensor_split: &str,
    active_count: usize,
) -> Result<Child, String> {
    let mut cmd = Command::new(server_bin);
    cmd.arg("-m").arg(model_path);
    for f in flags {
        // Strip outer shell quotes added for display if passing directly via execve
        cmd.arg(f.trim_matches('"'));
    }
    if !rpc_arg.is_empty() {
        cmd.arg("--rpc").arg(rpc_arg);
    }
    if active_count > 1 && !tensor_split.is_empty() {
        cmd.arg("--tensor-split").arg(tensor_split);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.spawn()
        .map_err(|e| format!("Failed to launch {server_bin}: {e}"))
}
