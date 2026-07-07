# Grafana's all-in-one OpenTelemetry backend: OTel Collector + Prometheus (metrics) +
# Tempo (traces) + Loki (logs) + Grafana, in one image. The turtle-research worker/MCP
# push OTLP (all three signals) to :4318; Grafana (public, :3000) shows them. Data
# persists under /data (mount a Railway volume there).
FROM grafana/otel-lgtm:latest

# Our LLM-usage dashboard + its provisioning, set as the Grafana home dashboard.
COPY deploy/otel-lgtm/dashboards/turtle-llm.json /otel-lgtm/grafana/conf/provisioning/dashboards/custom/turtle-llm.json
COPY deploy/otel-lgtm/dashboards-provisioning.yaml /otel-lgtm/grafana/conf/provisioning/dashboards/custom.yaml

ENV GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/otel-lgtm/grafana/conf/provisioning/dashboards/custom/turtle-llm.json \
    GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
    GF_SECURITY_ALLOW_EMBEDDING=true
