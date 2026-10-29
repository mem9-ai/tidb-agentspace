use std::{ffi::c_void, sync::OnceLock};
use workspace_contracts::{Result, ServiceError};

type Describe = unsafe extern "C" fn(*mut c_void) -> i32;
unsafe extern "C" {
    fn duckdb_register_static_extension(describe: Describe) -> i32;
    fn duckdb_extension_core_functions_describe(descriptor: *mut c_void) -> i32;
    fn duckdb_extension_json_describe(descriptor: *mut c_void) -> i32;
    fn duckdb_extension_parquet_describe(descriptor: *mut c_void) -> i32;
    fn duckdb_extension_loadable_extensions_describe(descriptor: *mut c_void) -> i32;
}

pub fn initialize() -> Result<()> {
    static READY: OnceLock<bool> = OnceLock::new();
    if *READY.get_or_init(|| {
        let descriptors: [Describe; 4] = [
            duckdb_extension_core_functions_describe,
            duckdb_extension_json_describe,
            duckdb_extension_parquet_describe,
            duckdb_extension_loadable_extensions_describe,
        ];
        descriptors.into_iter().all(|describe| {
            // DuckDB 2.0 owns/initializes the opaque descriptor. The function signatures
            // match its pinned duckdb_static_extension.h; Rust never dereferences it.
            unsafe { duckdb_register_static_extension(describe) == 0 }
        })
    }) {
        Ok(())
    } else {
        Err(ServiceError::new(503, "DUCKDB_RUNTIME_UNAVAILABLE"))
    }
}
