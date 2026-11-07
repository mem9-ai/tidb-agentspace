use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

pub const MIB: u64 = 1024 * 1024;

/// One budget covers all database instances in a host or container allocation.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub total_mi_b: Option<u64>,
    pub instances: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub memory_bytes: u64,
    pub total_mi_b: u64,
    pub instances: u16,
    pub per_instance_mi_b: u64,
}

impl Policy {
    pub fn resolve(&self, local_instances: usize) -> Result<Allocation> {
        self.allocate(memory_capacity()?, local_instances)
    }

    pub fn allocate(&self, memory_bytes: u64, local_instances: usize) -> Result<Allocation> {
        ensure!(
            memory_bytes > 0,
            "Cannot determine the runtime memory capacity"
        );
        let instances = self.instances.unwrap_or(u16::try_from(local_instances)?);
        ensure!(
            instances > 0 && usize::from(instances) >= local_instances,
            "Cache instance count must include every local database"
        );
        // Reserve 90 percent for the OS, APIs, MemTables, compaction and execution workers.
        let total_mi_b = self.total_mi_b.unwrap_or(memory_bytes / 10 / MIB);
        ensure!(
            total_mi_b <= memory_bytes / MIB,
            "Cache budget exceeds the runtime memory capacity"
        );
        Ok(Allocation {
            memory_bytes,
            total_mi_b,
            instances,
            per_instance_mi_b: total_mi_b / u64::from(instances),
        })
    }
}

impl Allocation {
    pub fn instance(&self, configured: Option<u64>) -> Result<u64> {
        let mib = configured.unwrap_or(self.per_instance_mi_b);
        ensure!(
            mib <= self.per_instance_mi_b,
            "blockCacheMib exceeds this instance's share of the total cache budget"
        );
        Ok(mib)
    }
}

pub fn memory_capacity() -> Result<u64> {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let mut capacity = system.total_memory();
    ensure!(capacity > 0, "Cannot determine the runtime memory capacity");
    if let Some(limits) = system.cgroup_limits() {
        capacity = capacity.min(limits.total_memory);
    }
    #[cfg(target_os = "linux")]
    {
        // Also inspect nested cgroups when the process uses the host's cgroup namespace.
        if let (Ok(groups), Ok(mounts)) = (
            std::fs::read_to_string("/proc/self/cgroup"),
            std::fs::read_to_string("/proc/self/mountinfo"),
        ) {
            capacity = linux_capacity(capacity, &groups, &mounts, |path| {
                std::fs::read_to_string(path).ok()
            });
        }
    }
    ensure!(capacity > 0, "Cannot determine the runtime memory capacity");
    Ok(capacity)
}

#[cfg(any(target_os = "linux", test))]
fn linux_capacity(
    mut capacity: u64,
    groups: &str,
    mounts: &str,
    read: impl Fn(&std::path::Path) -> Option<String>,
) -> u64 {
    use std::path::{Component, Path, PathBuf};
    fn unescape(value: &str) -> PathBuf {
        PathBuf::from(
            value
                .replace("\\040", " ")
                .replace("\\011", "\t")
                .replace("\\012", "\n")
                .replace("\\134", "\\"),
        )
    }
    for line in mounts.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let fields: Vec<_> = left.split_whitespace().collect();
        let fs: Vec<_> = right.split_whitespace().collect();
        if fields.len() < 5 || fs.len() < 3 {
            continue;
        }
        let v2 = fs[0] == "cgroup2";
        if !v2 && !(fs[0] == "cgroup" && fs[2].split(',').any(|s| s == "memory")) {
            continue;
        }
        for group in groups.lines() {
            let parts: Vec<_> = group.splitn(3, ':').collect();
            if parts.len() != 3
                || (v2 && !parts[1].is_empty())
                || (!v2 && !parts[1].split(',').any(|s| s == "memory"))
            {
                continue;
            }
            let root = unescape(fields[3]);
            let mount = unescape(fields[4]);
            let Ok(relative) = Path::new(parts[2]).strip_prefix(&root) else {
                continue;
            };
            if relative
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
            {
                continue;
            }
            let mut current = mount.join(relative);
            loop {
                let path = current.join(if v2 {
                    "memory.max"
                } else {
                    "memory.limit_in_bytes"
                });
                if let Some(limit) = read(&path).and_then(|s| s.trim().parse::<u64>().ok()) {
                    capacity = capacity.min(limit);
                }
                if current == mount || !current.pop() {
                    break;
                }
            }
        }
    }
    capacity
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_system_budget_is_split_across_local_and_remote_processes() {
        let memory = 24 * 1024 * MIB;
        let allocation = Policy::default().allocate(memory, 3).unwrap();
        assert_eq!(allocation.total_mi_b, 2457);
        assert_eq!(allocation.per_instance_mi_b, 819);
        let policy = Policy {
            total_mi_b: Some(2457),
            instances: Some(3),
        };
        let child = policy.allocate(memory, 1).unwrap();
        assert_eq!(child.per_instance_mi_b, 819);
        assert!(child.per_instance_mi_b * 3 <= child.total_mi_b);
        assert_eq!(child.instance(Some(0)).unwrap(), 0);
        assert!(child.instance(Some(820)).is_err());
        assert!(policy.allocate(memory, 4).is_err());
    }

    #[test]
    fn small_memory_and_explicit_budgets_never_exceed_capacity() {
        assert_eq!(
            Policy::default()
                .allocate(512 * MIB, 2)
                .unwrap()
                .per_instance_mi_b,
            25
        );
        let disabled = Policy {
            total_mi_b: Some(0),
            instances: None,
        };
        assert_eq!(
            disabled.allocate(MIB, 2).unwrap().instance(None).unwrap(),
            0
        );
        assert!(Policy::default().allocate(0, 1).is_err());
        assert!(Policy::default().allocate(MIB, 0).is_err());
        assert!(
            Policy {
                total_mi_b: Some(u64::MAX),
                instances: None
            }
            .allocate(MIB, 1)
            .is_err()
        );
        assert_eq!(
            Policy::default()
                .allocate(MIB, 64)
                .unwrap()
                .per_instance_mi_b,
            0
        );
    }

    #[test]
    fn cgroup_limits_include_ancestors_and_both_linux_versions() {
        let host = 64 * 1024 * MIB;
        for (groups, mounts, files) in [
            (
                "0::/parent/child\n",
                "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
                vec![
                    ("/sys/fs/cgroup/parent/child/memory.max", "max".to_owned()),
                    ("/sys/fs/cgroup/parent/memory.max", (512 * MIB).to_string()),
                    ("/sys/fs/cgroup/memory.max", (1024 * MIB).to_string()),
                ],
            ),
            (
                "7:memory:/parent/child\n",
                "1 0 0:1 /parent /cg rw - cgroup cgroup rw,memory",
                vec![
                    ("/cg/child/memory.limit_in_bytes", (1024 * MIB).to_string()),
                    ("/cg/memory.limit_in_bytes", (512 * MIB).to_string()),
                ],
            ),
        ] {
            let actual = linux_capacity(host, groups, mounts, |path| {
                files
                    .iter()
                    .find(|(name, _)| path == std::path::Path::new(name))
                    .map(|(_, v)| v.clone())
            });
            assert_eq!(actual, 512 * MIB);
            assert_eq!(
                Policy::default()
                    .allocate(actual, 2)
                    .unwrap()
                    .per_instance_mi_b,
                25
            );
        }
        assert_eq!(linux_capacity(host, "", "", |_| None), host);
    }
}
