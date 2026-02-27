const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { Resource } = require('@opentelemetry/resources');
const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const otlpHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS ?
  Object.fromEntries(
    process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map(h => {
      const [key, value] = h.split('=');
      return [key.trim(), value.trim()];
    })
  ) : {};

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]: 'investment-service',
    [SEMRESATTRS_SERVICE_VERSION]: '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'production',
    'service.language': 'nodejs',
  }),
  traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces`, headers: otlpHeaders }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics`, headers: otlpHeaders }),
    exportIntervalMillis: 10000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(
    new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs`, headers: otlpHeaders })
  ),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown().then(() => process.exit(0)));
