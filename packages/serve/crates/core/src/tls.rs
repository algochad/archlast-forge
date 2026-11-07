//! HTTPS: certificate selection by SNI name, optional client certificates (mTLS), HTTP/1.1 only.
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer},
    server::{ClientHello, ResolvesServerCert, WebPkiClientVerifier},
    sign::CertifiedKey,
    RootCertStore, ServerConfig,
};
use std::{collections::HashMap, sync::Arc};
use tokio_rustls::TlsAcceptor;

/// One certificate and what it is for, as passed from JS.
pub struct TlsEntry {
    pub cert: String,
    pub key: String,
    /// SNI name this certificate answers to (`*.example.com` matches one label); empty: the default certificate.
    pub server_name: String,
    /// PEM bundle of certificate authorities clients must chain to; empty: no client certificates.
    pub ca: String,
    pub request_cert: bool,
    /// With `request_cert`: refuse clients that present no valid certificate (otherwise they are let in).
    pub reject_unauthorized: bool,
    /// Protocol versions this server must not negotiate (taken from the first entry, like the client-certificate setup).
    pub no_tls12: bool,
    pub no_tls13: bool,
}

#[derive(Debug)]
struct Sni {
    by_name: HashMap<String, Arc<CertifiedKey>>,
    wildcards: Vec<(String, Arc<CertifiedKey>)>,
    default: Arc<CertifiedKey>,
}

impl ResolvesServerCert for Sni {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        if let Some(name) = hello.server_name() {
            let name = name.to_ascii_lowercase();
            if let Some(k) = self.by_name.get(&name) {
                return Some(k.clone());
            }
            if let Some((_, rest)) = name.split_once('.') {
                if let Some((_, k)) = self.wildcards.iter().find(|(w, _)| w == rest) {
                    return Some(k.clone());
                }
            }
        }
        Some(self.default.clone())
    }
}

fn certified(e: &TlsEntry) -> Result<Arc<CertifiedKey>, String> {
    if e.key.contains("ENCRYPTED PRIVATE KEY") {
        return Err("encrypted private keys are not supported: decrypt the key first (openssl pkey -in key.pem)".into());
    }
    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut e.cert.as_bytes()).collect::<Result<_, _>>().map_err(|err| format!("tls: bad certificate: {err}"))?;
    if certs.is_empty() {
        return Err("tls: the certificate PEM contains no certificate".into());
    }
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut e.key.as_bytes())
        .map_err(|err| format!("tls: bad private key: {err}"))?
        .ok_or("tls: the key PEM contains no private key")?;
    let signing = rustls::crypto::ring::sign::any_supported_type(&key).map_err(|err| format!("tls: unsupported private key: {err}"))?;
    Ok(Arc::new(CertifiedKey::new(certs, signing)))
}

pub fn build(entries: &[TlsEntry], http2: bool) -> Result<TlsAcceptor, String> {
    let first = entries.first().ok_or("tls: no certificate given")?;
    let mut by_name = HashMap::new();
    let mut wildcards = Vec::new();
    let mut default = None;
    for e in entries {
        let k = certified(e)?;
        if e.server_name.is_empty() {
            default.get_or_insert(k);
        } else if let Some(rest) = e.server_name.strip_prefix("*.") {
            wildcards.push((rest.to_ascii_lowercase(), k));
        } else {
            by_name.insert(e.server_name.to_ascii_lowercase(), k.clone());
            default.get_or_insert(k);
        }
    }
    let default = default.unwrap_or_else(|| wildcards[0].1.clone());

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut versions: Vec<&'static rustls::SupportedProtocolVersion> = Vec::new();
    if !entries[0].no_tls13 {
        versions.push(&rustls::version::TLS13);
    }
    if !entries[0].no_tls12 {
        versions.push(&rustls::version::TLS12);
    }
    if versions.is_empty() {
        return Err("tls: minVersion and maxVersion leave no protocol version".to_string());
    }
    let builder = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&versions)
        .map_err(|e| format!("tls: {e}"))?;
    // Client certificates (mTLS) are configured on the server as a whole, from the first entry that asks for them.
    let builder = match entries.iter().find(|e| e.request_cert || !e.ca.is_empty()) {
        Some(e) => {
            let mut roots = RootCertStore::empty();
            for c in rustls_pemfile::certs(&mut e.ca.as_bytes()) {
                roots.add(c.map_err(|err| format!("tls: bad CA certificate: {err}"))?).map_err(|err| format!("tls: bad CA certificate: {err}"))?;
            }
            let mut v = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider);
            if !e.reject_unauthorized {
                v = v.allow_unauthenticated();
            }
            builder.with_client_cert_verifier(v.build().map_err(|err| format!("tls: client verifier: {err}"))?)
        }
        None => builder.with_no_client_auth(),
    };
    let _ = first;
    let mut cfg = builder.with_cert_resolver(Arc::new(Sni { by_name, wildcards, default }));
    cfg.alpn_protocols = if http2 { vec![b"h2".to_vec(), b"http/1.1".to_vec()] } else { vec![b"http/1.1".to_vec()] };
    Ok(TlsAcceptor::from(Arc::new(cfg)))
}
