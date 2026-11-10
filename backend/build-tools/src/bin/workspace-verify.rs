//! Native acceptance entry point. CI also compiles this single std-only file from its trusted base.
use std::{
    collections::BTreeSet,
    env, fs,
    io::{self, Write},
    path::Path,
    process::Command,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const SUPPORT: &str = "workspace-test-support";

fn checked(command: &mut Command) -> Result<()> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!("{command:?} exited with {status}").into());
    }
    Ok(())
}
fn cargo() -> Command {
    // cargo run describes the launcher package in its environment. Passing that
    // metadata to Cargo invalidates ring's build script and its downstream crates.
    let mut command = Command::new("cargo");
    for (key, _) in env::vars_os() {
        if key
            .to_str()
            .is_some_and(|k| k.starts_with("CARGO_PKG_") || k.starts_with("CARGO_MANIFEST_"))
        {
            command.env_remove(key);
        }
    }
    command
}

fn tests(targets: &[&str], names: &[&str]) -> Result<()> {
    let mut cmd = cargo();
    cmd.args(["test", "--locked"]);
    if targets.is_empty() {
        cmd.args(["-p", SUPPORT, "--tests"]);
    } else {
        // All named acceptance targets share the binaries' workspace feature selection.
        cmd.arg("--workspace");
    }
    for target in targets {
        cmd.args(["--test", target]);
    }
    cmd.args(["--", "--include-ignored", "--test-threads=1"]);
    if names.is_empty() {
        return checked(&mut cmd);
    }
    // A misspelled or filtered-out case must fail a targeted profile even if Cargo exits zero.
    let result = cmd.arg("--exact").args(names).output()?;
    io::stdout().write_all(&result.stdout)?;
    io::stderr().write_all(&result.stderr)?;
    let stdout = std::str::from_utf8(&result.stdout)?;
    if !result.status.success()
        || names
            .iter()
            .any(|name| !stdout.lines().any(|l| l == format!("test {name} ... ok")))
    {
        return Err(format!("Incomplete native cases in {targets:?}: {names:?}").into());
    }
    Ok(())
}
fn targets(root: &Path) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for file in fs::read_dir(root)? {
        let file = file?;
        if file.file_type()?.is_file() && file.path().extension().is_some_and(|x| x == "rs") {
            names.insert(
                file.path()
                    .file_stem()
                    .unwrap()
                    .to_str()
                    .ok_or("non-UTF8 test name")?
                    .into(),
            );
        }
    }
    Ok(names)
}
fn product(name: &str) -> bool {
    name.starts_with("product")
        || name.starts_with("workflow")
        || matches!(
            name,
            "backend_workflows" | "sales_sample" | "tutorial" | "agent_trial"
        )
}
fn separate_hosts() -> Result<()> {
    checked(cargo().args([
        "test",
        "--locked",
        "--workspace",
        "--test",
        "local_runtime",
        "--test",
        "package",
        "--",
        "--ignored",
        "--test-threads=1",
    ]))
}
fn run(profile: &str) -> Result<()> {
    let all = targets(Path::new("backend/test-support/tests"))?;
    if ![
        "agent_trial",
        "backend_workflows",
        "contract",
        "guest_host",
        "host_transport",
        "identity_directory",
        "meta",
        "product",
        "product_api",
        "product_lifecycle",
        "sales_sample",
        "sso",
        "tutorial",
    ]
    .iter()
    .all(|name| all.contains(*name))
    {
        return Err("Native acceptance target missing".into());
    }
    match profile {
        "all" => {
            tests(&[], &[])?;
            separate_hosts()
        }
        "product" | "other" => {
            let group: Vec<_> = all
                .iter()
                .map(String::as_str)
                .filter(|name| product(name) == (profile == "product"))
                .collect();
            tests(&group, &[])?;
            if profile == "other" {
                separate_hosts()?;
            }
            Ok(())
        }
        "history" => {
            tests(
                &["meta"],
                &["inactive_history_remains_isolated_across_restart"],
            )?;
            tests(&["guest_host", "contract"], &[])?;
            tests(
                &["sso"],
                &[
                    "hosted_sso_verifies_browser_identity_grants_and_single_use_state",
                    "sso_logout_during_create_prevents_import_rows",
                ],
            )?;
            tests(
                &["product"],
                &[
                    "audit_outage_blocks_mutation_before_provider_io",
                    "audit_history_distinguishes_succeeded_denied_and_unknown_without_private_content",
                    "request_history_redacts_secrets_paths_and_other_workspaces",
                    "history_requires_owner_and_discloses_unavailable_collection",
                    "concurrent_creations_share_one_idempotency_result",
                ],
            )
        }
        "classic" | "tutorial" | "files" | "database" => {
            tests(
                &["meta"],
                &["metadata_isolates_records_replays_receipts_and_fences_crashed_owners"],
            )?;
            tests(&["contract", "guest_host"], &[])?;
            let mut tutorial = vec![
                "progress_with_remote_metadata",
                "portal_sample_imports_and_analyzes_the_same_orders_after_crash",
            ];
            if profile == "tutorial" {
                tutorial.push("progress_with_embedded_metadata");
            }
            tests(&["tutorial"], &tutorial)?;
            if matches!(profile, "database" | "files") {
                tests(&["product_api", "backend_workflows"], &[])?;
                let mut cases = vec![
                    "remote_metadata_hybrid_workflows",
                    "embedded_metadata_hybrid_workflows",
                ];
                if profile == "database" {
                    cases.push("provider_creation_intents_survive_uncertain_outcomes_and_restart");
                }
                tests(&["product_lifecycle"], &cases)?;
                if profile == "files" {
                    tests(
                        &["product"],
                        &[
                            "audit_outage_blocks_mutation_before_provider_io",
                            "audit_history_distinguishes_succeeded_denied_and_unknown_without_private_content",
                            "image_preview_rejects_oversized_images_before_read",
                            "parallel_writes_to_two_filesystems_preserve_both_events",
                            "deleting_filesystem_clears_index_in_batches",
                            "directory_deletion_and_conditional_writes_are_atomic",
                            "ten_thousand_files_support_bounded_pages_and_point_operations",
                            "index_migration_only_reads_selected_filesystem_and_survives_restart",
                        ],
                    )?;
                }
                Ok(())
            } else {
                tests(
                    &["product_lifecycle"],
                    &["remote_metadata_hybrid_workflows"],
                )
            }
        }
        _ => Err(
            "Expected all, other, product, history, classic, tutorial, files or database".into(),
        ),
    }
}
fn main() -> Result<()> {
    let profile = env::args().nth(1).unwrap_or_else(|| "all".into());
    run(&profile)
}

#[cfg(test)]
mod suite_tests {
    use super::*;
    #[test]
    fn partition_covers_all_native_targets_including_new_files_once() {
        let listed = [
            "contract",
            "product",
            "product_api",
            "workflow_import",
            "meta",
            "future_test",
        ];
        let (mut data, mut other): (Vec<_>, Vec<_>) =
            listed.into_iter().partition(|name| product(name));
        assert_eq!(data, ["product", "product_api", "workflow_import"]);
        assert_eq!(other, ["contract", "meta", "future_test"]);
        data.append(&mut other);
        assert_eq!(data.len(), listed.len());
    }
}
