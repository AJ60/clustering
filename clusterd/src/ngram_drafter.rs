/// Pure-Rust lock-free Prompt Lookup (N-gram) Drafter:
/// Scans suffix n-grams (n = 3..=6 words/tokens) inside the prompt window to propose
/// deterministic continuation candidates for coding, RAG, and summarization prompts (0 extra VRAM).
pub fn propose_ngram_draft(prompt_text: &str, max_draft_tokens: usize) -> Option<Vec<String>> {
    let tokens: Vec<&str> = prompt_text.split_whitespace().collect();
    if tokens.len() < 16 {
        return None;
    }

    for n in (3..=6).rev() {
        if tokens.len() <= n + 2 {
            continue;
        }
        let suffix = &tokens[tokens.len() - n..];
        let search_limit = tokens.len() - n;
        for start in (0..search_limit).rev() {
            if &tokens[start..start + n] == suffix {
                let end = (start + n + max_draft_tokens).min(search_limit);
                if end > start + n {
                    return Some(
                        tokens[start + n..end]
                            .iter()
                            .map(|s| (*s).to_string())
                            .collect(),
                    );
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_matching_prompt_suffix_continuation() {
        let prompt = "fn compute_cluster_plan(nodes) -> ClusterPlan { allocate } please repeat: fn compute_cluster_plan(nodes)";
        let draft = propose_ngram_draft(prompt, 4);
        assert!(draft.is_some());
        let toks = draft.unwrap();
        assert_eq!(toks[0], "->");
    }
}
