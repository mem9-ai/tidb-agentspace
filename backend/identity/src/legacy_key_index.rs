//! Derivation of a protected lookup path for legacy Key migration.
//!
//! This is deliberately only an index primitive: it neither copies a Key nor establishes a
//! new authority, authenticates callers, or authorizes cutover. The regional Key writer
//! remains authoritative until a separately fenced and reconciled migration is implemented.
use hmac::{Hmac, Mac};
use sha2::Sha256;
use workspace_contracts::Result;

use crate::error;

const DOMAIN: &[u8] = b"tidb.ai/global-legacy-key-index/v1\0";

/// Derive a versioned metadata key without placing the legacy verifier in its name.
///
/// `index_key` must come from protected, recoverable Global-only secret storage. An operator
/// must retain old versions during reindexing; this function does not perform rotation or
/// fallback and a caller must fail closed if an expected key is unavailable. `verifier` is
/// the *already stored* SHA-256 of the original Key, not a second hash of that digest.
pub fn legacy_index_path(
    version: u32,
    index_key: &[u8],
    workspace: &str,
    verifier: &[u8],
) -> Result<String> {
    if version == 0 || index_key.len() != 32 {
        return Err(error(503, "LEGACY_INDEX_KEY_UNAVAILABLE"));
    }
    if workspace.is_empty()
        || workspace.len() > 128
        || workspace == "."
        || workspace == ".."
        || !workspace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        || verifier.len() != 32
    {
        return Err(error(400, "INVALID_LEGACY_KEY_RECORD"));
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(index_key)
        .map_err(|_| error(503, "LEGACY_INDEX_KEY_UNAVAILABLE"))?;
    mac.update(DOMAIN);
    mac.update(&(workspace.len() as u32).to_be_bytes());
    mac.update(workspace.as_bytes());
    mac.update(verifier);
    Ok(format!(
        "legacy-index/v{version}/{}",
        hex::encode(mac.finalize().into_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn protected_index_is_stable_workspace_scoped_and_never_contains_the_verifier() {
        let key = [7u8; 32];
        let verifier = Sha256::digest(b"aw_demo_synthetic_test_credential");
        let path = legacy_index_path(1, &key, "ws_agentlab", &verifier).unwrap();
        assert_eq!(
            path,
            "legacy-index/v1/1af427bb2711e24eb0fa23736d5dd75e24fa24e7c01af318a5ab24fa4013904f"
        );
        assert_eq!(
            path,
            legacy_index_path(1, &key, "ws_agentlab", &verifier).unwrap()
        );
        assert_ne!(
            path,
            legacy_index_path(1, &key, "ws_other", &verifier).unwrap()
        );
        assert_ne!(
            path,
            legacy_index_path(1, &[8u8; 32], "ws_agentlab", &verifier).unwrap()
        );
        assert_ne!(
            path,
            legacy_index_path(2, &key, "ws_agentlab", &verifier).unwrap()
        );
        assert!(!path.contains(&hex::encode(verifier)));
        assert!(!path.contains("synthetic_test_credential"));
    }

    #[test]
    fn missing_index_material_and_malformed_source_fail_closed() {
        assert!(legacy_index_path(0, &[7u8; 32], "ws_agentlab", &[0; 32]).is_err());
        assert!(legacy_index_path(1, &[], "ws_agentlab", &[0; 32]).is_err());
        assert!(legacy_index_path(1, &[7u8; 32], "../other", &[0; 32]).is_err());
        assert!(legacy_index_path(1, &[7u8; 32], "ws_agentlab", &[0; 31]).is_err());
    }
}
