# eBPF Kernel Observability – Operator Runbook

This document describes the eBPF-based kernel tracing stack deployed for
very-prince.  It captures TCP socket latency, HTTP/tRPC payload durations, and
PostgreSQL query I/O bottlenecks at the Linux kernel layer using Cilium Hubble
and Pixie, with zero changes to Node.js or Rust application source code.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  EKS Worker Node (Linux ≥ 4.14)                                         │
│                                                                         │
│  ┌─────────────────────────────────┐   ┌────────────────────────────┐  │
│  │  Cilium Agent (DaemonSet)       │   │  Pixie PEM (DaemonSet)     │  │
│  │  eBPF programs in kernel:       │   │  eBPF programs in kernel:  │  │
│  │  • XDP / TC hooks               │   │  • uprobe / kprobe hooks   │  │
│  │  • socket LB                    │   │  • Postgres wire-protocol  │  │
│  │  • Hubble ring-buffer           │   │  • HTTP/gRPC body capture  │  │
│  └───────────┬─────────────────────┘   └──────────┬─────────────────┘  │
│              │ Hubble metrics                      │ OTEL gRPC          │
└──────────────┼─────────────────────────────────────┼────────────────────┘
               ▼                                     ▼
        Hubble Relay                       otel-collector (sidecar)
               │                                     │
               └──────────────┬──────────────────────┘
                              ▼
                         Prometheus (kube-prometheus-stack)
                              │
                              ▼
                           Grafana
                   Dashboard: "very-prince – eBPF Kernel I/O Observability"
```

All telemetry flows out of kernel-space eBPF programs into user-space
collectors.  **No application code is modified.**

---

## Prerequisites

| Requirement | Version |
|---|---|
| Linux kernel on worker nodes | ≥ 4.14 (≥ 5.8 recommended for BTF) |
| EKS worker node AMI | Amazon Linux 2 / Bottlerocket |
| Helm | ≥ 3.12 |
| kubectl | ≥ 1.28 |
| Pixie Cloud account (SaaS) or self-hosted Pixie Cloud | — |

---

## Step-by-step installation

### 1 – Add Helm repositories

```bash
helm repo add cilium            https://helm.cilium.io
helm repo add pixie             https://pixie-operator-charts.storage.googleapis.com
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
```

### 2 – Install kube-prometheus-stack (Prometheus Operator + Grafana)

```bash
helm upgrade --install kube-prometheus-stack \
  prometheus-community/kube-prometheus-stack \
  --version 58.3.3 \
  --namespace monitoring --create-namespace \
  --set grafana.adminPassword="<STRONG_PASSWORD>" \
  -f k8s/observability/kube-prometheus-stack-values.yaml
```

Wait for all pods to be `Running`:

```bash
kubectl -n monitoring rollout status deployment kube-prometheus-stack-grafana
```

### 3 – Install Cilium (replaces kube-proxy)

> **Warning**: Installing Cilium will replace `kube-proxy`.  Schedule this
> during a maintenance window.  On EKS, first disable the `aws-node` DaemonSet:
>
> ```bash
> kubectl -n kube-system patch daemonset aws-node \
>   --type strategic --patch \
>   '{"spec":{"template":{"spec":{"nodeSelector":{"no-such-node":"true"}}}}}'
> ```

```bash
helm upgrade --install cilium cilium/cilium \
  --version 1.15.6 \
  --namespace kube-system \
  -f k8s/observability/cilium-values.yaml
```

Verify Cilium and Hubble status:

```bash
cilium status --wait
cilium hubble enable
hubble observe --last 20
```

### 4 – Create the Pixie deploy-key Secret

Obtain a deploy key from the [Pixie Cloud console](https://work.withpixie.ai)
(**Admin → Keys → + New Key**), then:

```bash
kubectl create namespace pl
kubectl create secret generic pixie-deploy-key \
  --namespace pl \
  --from-literal=deploy-key=<YOUR_PIXIE_DEPLOY_KEY>
```

### 5 – Install Pixie Operator

```bash
helm upgrade --install pixie-operator pixie/pixie-operator-chart \
  --namespace pl --create-namespace \
  -f k8s/observability/pixie-values.yaml
```

Verify Pixie Vizier pods are running:

```bash
kubectl -n pl get pods
# Expected: px-vizier-query-broker, px-kelvin, pem-* DaemonSet pods
```

### 6 – Apply Prometheus CRD manifests + Grafana dashboard

```bash
kubectl apply -k k8s/observability/
```

This creates:
- `ServiceMonitor/cilium-hubble` – scrapes Hubble metrics
- `ServiceMonitor/cilium-agent` – scrapes Cilium agent metrics
- `PodMonitor/pixie-pem` – scrapes Pixie PEM OTEL bridge
- `PrometheusRule/very-prince-ebpf-alerts` – alerting rules
- `ConfigMap/very-prince-ebpf-dashboard` – auto-imported Grafana dashboard

### 7 – Access the Grafana dashboard

```bash
# Port-forward Grafana locally
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80

# Open in browser
open http://localhost:3000
```

Navigate to **Dashboards → very-prince → very-prince – eBPF Kernel I/O
Observability**.

---

## Metrics reference

### Cilium Hubble (network / TCP)

| Metric | Description |
|---|---|
| `hubble_flows_processed_total` | Total L3/L4/L7 flows; label `verdict` shows FORWARDED / DROPPED |
| `hubble_drop_total` | Packet drops by reason |
| `hubble_http_requests_total` | HTTP requests observed at kernel via L7 proxy |
| `hubble_tcp_flags_total` | TCP flag counters (SYN, FIN, RST) per endpoint |

### Pixie (PostgreSQL / application)

| Metric | Description |
|---|---|
| `px_postgres_query_duration_seconds` | Histogram of PostgreSQL query latency traced from the kernel wire-protocol |
| `px_http_request_duration_seconds` | HTTP request duration traced via uprobe |

### Container cgroups (node exporter / kubelet)

| Metric | Description |
|---|---|
| `container_fs_reads_bytes_total` | Cumulative bytes read from container filesystem |
| `container_fs_writes_bytes_total` | Cumulative bytes written |
| `container_cpu_cfs_throttled_periods_total` | CFS throttled scheduling periods |

---

## Alerting rules

Three alert groups are defined in `prometheus-scrape-configs.yaml`:

| Alert | Condition | Severity |
|---|---|---|
| `HighTCPForwardLatency` | p99 TCP forward latency > 100 ms for 2 min | warning |
| `TCPDropRateHigh` | Drop rate > 5 pkt/s for 1 min | critical |
| `PostgresQueryLatencyHigh` | p95 PG query latency > 500 ms for 3 min | warning |
| `ContainerDiskIOPressure` | Aggregate disk I/O > 50 MiB/s for 5 min | warning |
| `ContainerCPUThrottlingHigh` | Throttle ratio > 25 % for 5 min | warning |

---

## Upgrading

```bash
# Upgrade Cilium
helm upgrade cilium cilium/cilium \
  --version <NEW_VERSION> \
  --namespace kube-system \
  -f k8s/observability/cilium-values.yaml

# Upgrade Pixie Operator
helm upgrade pixie-operator pixie/pixie-operator-chart \
  --namespace pl \
  -f k8s/observability/pixie-values.yaml

# Re-apply CRD manifests
kubectl apply -k k8s/observability/
```

## Uninstalling

```bash
kubectl delete -k k8s/observability/
helm uninstall pixie-operator -n pl
helm uninstall cilium -n kube-system
helm uninstall kube-prometheus-stack -n monitoring
```

> **Note**: Removing Cilium re-enables the previous CNI.  Restore the
> `aws-node` DaemonSet if it was patched during installation.

---

## Security considerations

- Cilium enforces `NetworkPolicy` in `default` enforcement mode – no
  inbound/outbound traffic is blocked by default; policies can be layered on.
- Pixie PEM pods require `privileged: true` and host `pid` / `network`
  namespaces to load eBPF programs.  Restrict Pixie to dedicated node pools
  in high-security environments.
- The Hubble UI is not exposed via Ingress.  Access via `port-forward` only,
  or add authentication before exposing externally.
- Grafana `adminPassword` should be stored in a Kubernetes Secret or AWS
  Secrets Manager, not in plain Helm values.
