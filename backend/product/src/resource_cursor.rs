//! A bounded, type-filtered page may end on another type's ID. Seal that position
//! so pagination never discloses a hidden ID or needs to scan for a visible one.
use super::*;
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};

impl Product {
    async fn cursor_cipher(&self) -> Result<&Aes256Gcm> {
        self.cursor_cipher
            .get_or_try_init(|| async {
                let key = self.workspace.repository().resource_cursor_key().await?;
                Ok(Aes256Gcm::new((&key).into()))
            })
            .await
    }
    pub(super) async fn seal_resource_cursor(&self, id: &str, principal: &str) -> Result<String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let bytes = self
            .cursor_cipher()
            .await?
            .encrypt(
                &nonce,
                Payload {
                    msg: id.as_bytes(),
                    aad: principal.as_bytes(),
                },
            )
            .map_err(|_| err(503, "CURSOR_UNAVAILABLE"))?;
        Ok(URL_SAFE_NO_PAD.encode([nonce.as_slice(), &bytes].concat()))
    }
    pub(super) async fn open_resource_cursor(
        &self,
        token: &[u8],
        principal: &str,
    ) -> Result<String> {
        let invalid = || err(400, "INVALID_PAGE_CURSOR");
        let (nonce, bytes) = token.split_at_checked(12).ok_or_else(invalid)?;
        let id = self
            .cursor_cipher()
            .await?
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: bytes,
                    aad: principal.as_bytes(),
                },
            )
            .map_err(|_| invalid())?;
        String::from_utf8(id).map_err(|_| invalid())
    }
}
