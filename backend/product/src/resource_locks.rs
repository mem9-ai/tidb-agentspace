//! Bounded lock striping for resource lifecycles. Unknown multi-resource workflows
//! conservatively acquire every stripe so an indirect preparation stays fenced.
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    hash::{Hash, Hasher},
};

pub(super) const STRIPES: usize = 128;

pub(super) fn stripe(id: &str) -> usize {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hash);
    (hash.finish() as usize) % STRIPES
}

fn collect(value: &Value, output: &mut BTreeSet<usize>) {
    match value {
        Value::Object(values) => {
            for (key, value) in values {
                if ["resourceId", "sourceResourceId"].contains(&key.as_str()) {
                    if let Some(id) = value.as_str().filter(|id| !id.is_empty()) {
                        output.insert(stripe(id));
                    }
                } else {
                    collect(value, output);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect(value, output);
            }
        }
        _ => {}
    }
}

pub(super) fn plan(
    method: &str,
    route: &str,
    query: &BTreeMap<String, String>,
    input: &Value,
) -> (bool, Vec<usize>) {
    let parts = route
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let resource = match parts.as_slice() {
        ["resources", id, ..] => Some(*id),
        _ => None,
    };
    if method == "DELETE" && resource.is_some() {
        return (true, vec![stripe(resource.expect("resource"))]);
    }
    if method == "GET" && ["/context", "/bootstrap", "/resources", "/usage"].contains(&route) {
        return (false, Vec::new());
    }
    if (method == "POST" && route == "/resources")
        || route.starts_with("/database-import")
        || route.starts_with("/file-export")
        || route.starts_with("/result-export")
    {
        return (false, (0..STRIPES).collect());
    }
    let mut selected = BTreeSet::new();
    if let Some(id) = resource {
        selected.insert(stripe(id));
    }
    for (key, id) in query {
        if ["resourceId", "sourceResourceId"].contains(&key.as_str()) && !id.is_empty() {
            selected.insert(stripe(id));
        }
    }
    collect(input, &mut selected);
    if selected.is_empty() {
        (false, (0..STRIPES).collect())
    } else {
        (false, selected.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn plans_lock_every_selected_resource_and_unknown_workflows() {
        let query = BTreeMap::new();
        let (_, selected) = plan(
            "POST",
            "/queries",
            &query,
            &json!({"resourceId":"db_a","sources":[{"resourceId":"fs_b"}]}),
        );
        assert!(selected.contains(&stripe("db_a")));
        assert!(selected.contains(&stripe("fs_b")));
        assert_eq!(
            plan("DELETE", "/resources/db_a", &query, &json!({})),
            (true, vec![stripe("db_a")])
        );
        assert_eq!(
            plan("POST", "/file-exports", &query, &json!({})).1.len(),
            STRIPES
        );
        assert!(plan("GET", "/resources", &query, &json!({})).1.is_empty());
    }

    #[tokio::test]
    async fn unrelated_deletion_can_progress_while_a_resource_is_in_use() {
        use std::time::Duration;
        let locks: Vec<_> = (0..STRIPES).map(|_| tokio::sync::RwLock::new(())).collect();
        let first = stripe("resource-a");
        let other = (0..1000)
            .map(|n| stripe(&format!("resource-{n}")))
            .find(|index| *index != first)
            .expect("a different stripe");
        let _active = locks[first].read().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), locks[other].write())
                .await
                .is_ok()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), locks[first].write())
                .await
                .is_err()
        );
    }
}
