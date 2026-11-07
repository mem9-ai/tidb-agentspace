use slatedb::{
    Db, DbBuilder,
    db_cache::foyer::{FoyerCache, FoyerCacheOptions},
    object_store::ObjectStore,
};
use std::sync::Arc;

pub(crate) fn database_builder(
    path: String,
    store: Arc<dyn ObjectStore>,
    cache_mib: u64,
) -> DbBuilder<String> {
    // One pool covers data, indexes and filters. Never inherit the upstream split-cache budgets.
    let builder = Db::builder(path, store).with_db_cache_disabled();
    if cache_mib == 0 {
        return builder;
    }
    // Each engine owns a distinct cache, so cache scope 0 cannot cross installations.
    builder.with_db_cache(
        Arc::new(FoyerCache::new_with_opts(FoyerCacheOptions {
            max_capacity: cache_mib * 1024 * 1024,
            shards: 4,
        })),
        0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use slatedb::{
        config::{FlushOptions, FlushType, Settings},
        db_cache_stats::ACCESS_COUNT,
        object_store::memory::InMemory,
    };
    use slatedb_common::metrics::{DefaultMetricsRecorder, MetricValue};

    fn count(recorder: &DefaultMetricsRecorder, kind: &str, result: &str) -> u64 {
        recorder
            .snapshot()
            .by_name_and_labels(ACCESS_COUNT, &[("entry_kind", kind), ("result", result)])
            .map(|metric| match metric.value {
                MetricValue::Counter(value) => value,
                _ => panic!("Expected cache counter"),
            })
            .unwrap_or(0)
    }

    fn settings() -> Settings {
        Settings {
            compactor_options: None,
            min_filter_keys: 1,
            ..Default::default()
        }
    }

    async fn read(db: &Db) {
        assert_eq!(db.get(b"items/a").await.unwrap().unwrap(), "first");
        let mut scan = db.scan_prefix(b"items/", ..).await.unwrap();
        let first = scan.next().await.unwrap().unwrap();
        assert_eq!(first.key, "items/a");
        assert_eq!(first.value, "first");
        let second = scan.next().await.unwrap().unwrap();
        assert_eq!(second.key, "items/b");
        assert_eq!(second.value, "second");
        assert!(scan.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn reopened_sst_reads_hit_all_cache_kinds_and_zero_disables_caching() {
        let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
        let seed = database_builder("cache-test".into(), store.clone(), 0)
            .with_settings(settings())
            .build()
            .await
            .unwrap();
        seed.put(b"items/a", b"first").await.unwrap();
        seed.put(b"items/b", b"second").await.unwrap();
        seed.flush_with_options(FlushOptions {
            flush_type: FlushType::MemTable,
        })
        .await
        .unwrap();
        seed.close().await.unwrap();

        for cache_mib in [1, 0] {
            let recorder = Arc::new(DefaultMetricsRecorder::new());
            let db = database_builder("cache-test".into(), store.clone(), cache_mib)
                .with_settings(settings())
                .with_metrics_recorder(recorder.clone())
                .build()
                .await
                .unwrap();
            read(&db).await;
            let kinds = ["data_block", "index", "filter"];
            let cold = kinds.map(|kind| {
                (
                    count(&recorder, kind, "hit"),
                    count(&recorder, kind, "miss"),
                )
            });
            read(&db).await;
            for (kind, (hits, misses)) in kinds.into_iter().zip(cold) {
                if cache_mib > 0 {
                    assert!(misses > 0, "Cold {kind} read must load an SST entry");
                    assert!(count(&recorder, kind, "hit") > hits, "Warm {kind} hit");
                    assert_eq!(count(&recorder, kind, "miss"), misses);
                } else {
                    assert_eq!(count(&recorder, kind, "hit"), 0);
                    assert_eq!(count(&recorder, kind, "miss"), 0);
                }
            }
            db.close().await.unwrap();
        }
    }
}
