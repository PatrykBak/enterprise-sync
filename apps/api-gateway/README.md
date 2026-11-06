# API Gateway

API Gateway for the Enterprise Sync system. This service is the primary entry point for transaction data synchronization.

## Responsibilities
- Authenticating and authorizing requests via JWT with RBAC (`admin`).
- Streaming large file uploads directly to MinIO (S3-compatible storage) using Busboy with constant memory usage.
- Verifying file integrity via streaming SHA-256 calculation.
- Publishing synchronization events to RabbitMQ topic exchange (`integration.events`).
- Exposing Liveness and Readiness probes for Kubernetes.

## Running Locally

```bash
# Start infrastructure and both services
bash start-dev.sh
```

## Testing File Upload Pipeline

### 1. Obtain JWT Access Token:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"clientId":"admin-client","clientSecret":"dev-secret-token"}'
```

### 2. Generate Dummy NDJSON File:

```bash
node generate-dummy.js
```

### 3. Execute Sync Request:

```bash
curl -X POST http://localhost:3000/api/sync-transactions \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "X-Correlation-ID: 123e4567-e89b-12d3-a456-426614174000" \
  -H "X-Tenant-ID: test-tenant-1" \
  -H "X-Expected-Hash: <SHA256_HASH>" \
  -F "file=@dummy-2000mb.ndjson;type=application/x-ndjson"
```

## Health Probes
- `GET /health/liveness` — Verifies HTTP server availability.
- `GET /health/readiness` — Verifies connections to RabbitMQ and Redis.
