use axum::{
    body::Bytes,
    http::header::CONTENT_TYPE,
    response::{IntoResponse, Response},
};
use std::sync::OnceLock;
use workspace_openapi::View;

/// Cache the documents for one configured HTTP service. Other services in the
/// same process can advertise a different public mount.
#[derive(Default)]
pub(super) struct Published {
    documents: [OnceLock<Bytes>; View::ALL.len()],
}

impl Published {
    pub(super) fn serve(&self, view: View, mount: &str) -> Response {
        let body = self.documents[view as usize].get_or_init(|| {
            serde_json::to_vec(&view.mounted_document(mount))
                .expect("OpenAPI document must serialize")
                .into()
        });
        ([(CONTENT_TYPE, "application/json")], body.clone()).into_response()
    }
}
