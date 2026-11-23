//! ma owns SDK registration and export. The library uses only the API.
use opentelemetry::{KeyValue, global};
use opentelemetry_otlp::{MetricExporter, Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::{
    Resource,
    metrics::{SdkMeterProvider, periodic_reader_with_async_runtime::PeriodicReader},
    runtime::Tokio,
    trace::{SdkTracerProvider, span_processor_with_async_runtime::BatchSpanProcessor},
};

const ENDPOINT: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const PROTOCOL: &str = "OTEL_EXPORTER_OTLP_PROTOCOL";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Transport {
    Http,
    Grpc,
}

#[derive(Default)]
struct Signals {
    traces: Option<Transport>,
    metrics: Option<Transport>,
}

impl Signals {
    fn resolve(read: impl Fn(&str) -> Option<String>) -> Self {
        let var = |key: &str| read(key).filter(|s| !s.is_empty());
        if var("OTEL_SDK_DISABLED").is_some_and(|value| value.eq_ignore_ascii_case("true")) {
            return Self::default();
        }
        let base = var(ENDPOINT).is_some();
        let signal = |endpoint, protocol| {
            if !(base || var(endpoint).is_some()) {
                return None;
            }
            match var(protocol).or_else(|| var(PROTOCOL)).as_deref() {
                None | Some("http/protobuf") => Some(Transport::Http),
                Some("grpc") => Some(Transport::Grpc),
                Some(_) => {
                    eprintln!("Telemetry: unsupported OTLP transport; signal disabled");
                    None
                }
            }
        };
        Self {
            traces: signal(
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
            ),
            metrics: signal(
                "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
                "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
            ),
        }
    }
}

#[derive(Default)]
pub struct Export {
    traces: Option<SdkTracerProvider>,
    metrics: Option<SdkMeterProvider>,
}

impl Export {
    pub fn install() -> Self {
        let signals = Signals::resolve(|key| std::env::var(key).ok());
        if signals.traces.is_none() && signals.metrics.is_none() {
            return Self::default();
        }
        // Do not import arbitrary resource attributes. Do not diagnose exporter
        // errors with their raw text, which can contain endpoint or header values.
        let resource = Resource::builder_empty()
            .with_attribute(KeyValue::new(
                "service.name",
                std::env::var("OTEL_SERVICE_NAME")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "ma".into()),
            ))
            .build();
        // The official exporter resolves the per-signal endpoint, headers and
        // timeouts. The SDK builder resolves the sampler and its argument.
        let traces = signals.traces.and_then(|transport| {
            let exporter = match transport {
                Transport::Http => SpanExporter::builder()
                    .with_http()
                    .with_protocol(Protocol::HttpBinary)
                    .build(),
                Transport::Grpc => SpanExporter::builder().with_tonic().build(),
            };
            match exporter {
                Ok(exporter) => {
                    let provider = SdkTracerProvider::builder()
                        .with_resource(resource.clone())
                        .with_span_processor(BatchSpanProcessor::builder(exporter, Tokio).build())
                        .build();
                    global::set_tracer_provider(provider.clone());
                    Some(provider)
                }
                Err(_) => {
                    eprintln!("Telemetry: could not configure trace export");
                    None
                }
            }
        });
        let metrics = signals.metrics.and_then(|transport| {
            let exporter = match transport {
                Transport::Http => MetricExporter::builder()
                    .with_http()
                    .with_protocol(Protocol::HttpBinary)
                    .build(),
                Transport::Grpc => MetricExporter::builder().with_tonic().build(),
            };
            match exporter {
                Ok(exporter) => {
                    let provider = SdkMeterProvider::builder()
                        .with_resource(resource)
                        .with_reader(PeriodicReader::builder(exporter, Tokio).build())
                        .build();
                    global::set_meter_provider(provider.clone());
                    Some(provider)
                }
                Err(_) => {
                    eprintln!("Telemetry: could not configure metric export");
                    None
                }
            }
        });
        Self { traces, metrics }
    }

    pub async fn shutdown(self) {
        if self.traces.is_some() || self.metrics.is_some() {
            let _ = tokio::task::spawn_blocking(move || {
                if let Some(traces) = self.traces {
                    let _ = traces.shutdown();
                }
                if let Some(metrics) = self.metrics {
                    let _ = metrics.shutdown();
                }
            })
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signals(vars: &[(&str, &str)]) -> Signals {
        Signals::resolve(|key| {
            vars.iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).into())
        })
    }

    #[test]
    fn no_endpoint_does_not_build_either_exporter() {
        let no_endpoint = signals(&[
            (ENDPOINT, ""),
            (PROTOCOL, "grpc"),
            ("OTEL_EXPORTER_OTLP_HEADERS", "x-fixture=fixture"),
        ]);
        assert!(no_endpoint.traces.is_none());
        assert!(no_endpoint.metrics.is_none());
    }

    #[test]
    fn endpoints_and_transport_are_per_signal() {
        let trace_only = signals(&[(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "http://127.0.0.1:6006/custom",
        )]);
        assert_eq!(trace_only.traces, Some(Transport::Http));
        assert!(trace_only.metrics.is_none());
        let mixed = signals(&[
            (ENDPOINT, "http://127.0.0.1:6006"),
            (PROTOCOL, "grpc"),
            ("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/protobuf"),
        ]);
        assert_eq!(mixed.traces, Some(Transport::Http));
        assert_eq!(mixed.metrics, Some(Transport::Grpc));
        let disabled = signals(&[
            (ENDPOINT, "http://127.0.0.1:6006"),
            ("OTEL_SDK_DISABLED", "TrUe"),
        ]);
        assert!(disabled.traces.is_none());
        assert!(disabled.metrics.is_none());
    }
}
