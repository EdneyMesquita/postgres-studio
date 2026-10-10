//! rustls configurations for each `sslmode`.
//!
//! The driver itself only knows disable / prefer / require; what libpq calls
//! verify-ca and verify-full is a matter of how the certificate is checked,
//! which happens here.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error, RootCertStore, SignatureScheme,
};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error::{AppError, AppResult};
use crate::models::{SslMode, TlsOptions};

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

/// The connector for `options`, or `None` when TLS is off.
pub fn connector(options: &TlsOptions) -> AppResult<Option<MakeRustlsConnect>> {
    let provider = provider();
    let verifier: Arc<dyn ServerCertVerifier> = match options.ssl_mode {
        SslMode::Disable => return Ok(None),
        // libpq doesn't check the certificate in these modes either.
        SslMode::Prefer | SslMode::Require => Arc::new(AcceptAny(provider.clone())),
        SslMode::VerifyCa => Arc::new(AnyName(webpki(options, &provider)?)),
        SslMode::VerifyFull => webpki(options, &provider)?,
    };
    let builder = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::InvalidInput(format!("TLS setup failed: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(verifier);
    let config = match (&options.cert_file, &options.key_file) {
        (Some(cert), Some(key)) if !cert.is_empty() && !key.is_empty() => {
            let certs = CertificateDer::pem_file_iter(cert)
                .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                .map_err(|e| {
                    AppError::InvalidInput(format!("can't read the client certificate {cert}: {e}"))
                })?;
            let key = PrivateKeyDer::from_pem_file(key).map_err(|e| {
                AppError::InvalidInput(format!(
                    "can't read the client key {key} (it must be an unencrypted PEM key): {e}"
                ))
            })?;
            builder
                .with_client_auth_cert(certs, key)
                .map_err(|e| AppError::InvalidInput(format!("bad client certificate: {e}")))?
        }
        _ => builder.with_no_client_auth(),
    };
    Ok(Some(MakeRustlsConnect::new(config)))
}

fn webpki(
    options: &TlsOptions,
    provider: &Arc<CryptoProvider>,
) -> AppResult<Arc<WebPkiServerVerifier>> {
    let mut roots = RootCertStore::empty();
    match options.ca_file.as_deref().filter(|f| !f.is_empty()) {
        Some(path) => {
            let certs = CertificateDer::pem_file_iter(path)
                .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                .map_err(|e| {
                    AppError::InvalidInput(format!("can't read the CA file {path}: {e}"))
                })?;
            let (added, _) = roots.add_parsable_certificates(certs);
            if added == 0 {
                return Err(AppError::InvalidInput(format!(
                    "no certificates found in {path}"
                )));
            }
        }
        None => {
            let found = rustls_native_certs::load_native_certs();
            roots.add_parsable_certificates(found.certs);
            if roots.is_empty() {
                return Err(AppError::InvalidInput(
                    "no trusted CA certificates found on this system; choose a CA file".to_string(),
                ));
            }
        }
    }
    WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .map_err(|e| AppError::InvalidInput(format!("TLS setup failed: {e}")))
}

/// Checks signatures (so the handshake is still sound) but trusts any
/// certificate: `sslmode=require` and `prefer`.
#[derive(Debug)]
struct AcceptAny(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAny {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// A full chain check that accepts a certificate issued for another name:
/// `sslmode=verify-ca`.
#[derive(Debug)]
struct AnyName(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for AnyName {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
        {
            Err(Error::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}
