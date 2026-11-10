# Enterprise Sync

Event-driven monorepo for high-throughput, memory-safe synchronization of large transaction datasets into PostgreSQL.

A client uploads a large NDJSON file to the API Gateway, which streams it directly to object storage and publishes a single event. A background worker consumes that event, streams the file back, validates and masks the records, and persists them in batched transactions. All streaming is constant-memory: the files are never fully buffered in RAM.

## Architecture

```text
Client ─ HTTP ─▶ api-gateway ─ stream (Busboy) ─▶ MinIO (S3)
                     │
                     │ publish event
                     ▼
              RabbitMQ (topic exchange: integration.events, queue: tx-sync-jobs-v2)
                     │
                     ▼
             integration-worker ─ stream (readline) ─▶ MinIO
                     │
                     ├─▶ Redis (distributed lock / deduplication)
                     └─▶ PostgreSQL (Prisma, batched transactions)
```

### Packages

| Package | Description |
| --- | --- |
| `apps/api-gateway` | NestJS HTTP entry point: JWT auth + RBAC, Busboy streaming uploads to MinIO, streaming SHA-256 integrity check, event publishing to RabbitMQ, health probes. |
| `apps/integration-worker` | NestJS background worker: RabbitMQ consumer, Redis distributed locking, streaming NDJSON parsing, Zod validation + PII masking, batched Prisma persistence, DLQ / poison-pill handling, graceful shutdown. |
| `libs/shared` | Shared TypeScript library (`AppLogger` with correlation-ID support via `nestjs-cls`) used by both services. |

### Tech stack

NestJS · TypeScript · pnpm workspaces · PostgreSQL + Prisma · RabbitMQ (amqplib) · Redis (ioredis) · MinIO / S3 · Zod · Docker Compose

## Requirements

- Node.js 20.19 or newer (see `engines` in `package.json`).
- pnpm 10 or newer.
- Docker with the Compose v2 plugin.
- On Windows: Git Bash or WSL for `start-dev.sh`, or the PowerShell steps below.

## Quick start

```bash
pnpm install
bash start-dev.sh
```

The `start-dev.sh` script:

1. Creates `.env` from `.env.example` when it does not exist.
2. Starts PostgreSQL, Redis, RabbitMQ, and MinIO with Docker Compose and waits until all health checks pass.
3. Runs `prisma generate` and `prisma db push`.
4. Builds the shared library.
5. Starts the shared watcher, `api-gateway`, and `integration-worker` in watch mode.

The script keeps running because both services run in watch mode. Use `Ctrl+C` to stop them.

### Create the storage bucket once

The services do **not** automatically create the S3 bucket in production. Open the MinIO Console at <http://localhost:9001> (credentials from `.env`, default `admin` / `password`) and create the bucket defined in `S3_BUCKET_NAME` (default `transactions-bucket`). Without it, uploads fail with `NoSuchBucket`.

### PowerShell equivalent (Windows native)

```powershell
pnpm install
docker compose up -d
docker compose ps
pnpm --filter integration-worker prisma:generate
pnpm --filter integration-worker prisma:push
pnpm --filter "@enterprise-sync/shared" build
pnpm --parallel --filter "@enterprise-sync/shared" --filter "api-gateway" --filter "integration-worker" start:dev
```

Wait until `docker compose ps` reports all four containers as healthy before starting the Node processes.

### Local endpoints

| Service | URL | Notes |
| --- | --- | --- |
| API Gateway | <http://localhost:3000> | Public REST API and health probes. |
| Integration Worker | <http://localhost:3001> | Dedicated HTTP port for K8s health probes. |
| RabbitMQ Management | <http://localhost:15672> | Default login: `admin` / `password`. |
| MinIO Console | <http://localhost:9001> | Default login: `admin` / `password`. |

## End-to-end upload walkthrough

This section serves as the single source of truth for the end-to-end data flow. Service READMEs link here directly.

### 1. Generate a dummy NDJSON file

```bash
node generate-dummy.js
```

The generator lives at the repository root (`generate-dummy.js`). It writes `dummy-400mb.ndjson` (~400 MB) to the root directory and outputs its SHA-256 hash. The file is git-ignored. To modify the size, adjust `SIZE_IN_MB` in the script.

### 2. Obtain an access token

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"clientId":"admin-client","clientSecret":"dev-secret-token"}'
```

`clientId` must match `EXPECTED_CLIENT_ID` (default `admin-client`) and `clientSecret` must match `DEV_SECRET_TOKEN` from `.env`. The token is valid for 1 hour and includes the `admin` role.

### 3. Upload the file and schedule synchronization

Replace `<ACCESS_TOKEN>` and `<SHA256_HASH>` with the values from steps 1 and 2.

```bash
curl -X POST http://localhost:3000/api/sync-transactions \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "X-Correlation-ID: 123e4567-e89b-12d3-a456-426614174000" \
  -H "X-Tenant-ID: test-tenant-1" \
  -H "X-Expected-Hash: <SHA256_HASH>" \
  -F "file=@dummy-400mb.ndjson;type=application/x-ndjson"
```

| Input | Required | Notes |
| --- | --- | --- |
| `Authorization: Bearer <token>` | **yes** | JWT with the `admin` role. |
| `X-Tenant-ID` | **yes** | Non-empty tenant identifier. |
| `X-Expected-Hash` | **yes** | SHA-256 hex string of the exact uploaded bytes (`sha256:` prefix is accepted and stripped). |
| `X-Correlation-ID` | no | Custom tracing ID; generated via `crypto.randomUUID()` when omitted. |
| `file` (multipart field) | **yes** | Exactly one file, max 2 GB, MIME type `application/x-ndjson`, `application/json`, or `application/octet-stream`. |

Expected response: `202 Accepted`.

```json
{
  "status": "accepted",
  "correlationId": "123e4567-e89b-12d3-a456-426614174000"
}
```

### 4. Verify processing

- **Gateway log:** Event published to `integration.events` with generated `fileId`.
- **Worker log:** `Processing job: fileId=...` followed by `Job completed successfully`.
- **PostgreSQL:**

```sql
SELECT id, "fileId", status, "createdAt"
FROM "IntegrationJob"
ORDER BY "createdAt" DESC
LIMIT 5;

SELECT "transactionId", "senderAccount", "receiverAccount", amount, currency
FROM "TransactionLog"
ORDER BY "transactionId"
LIMIT 10;
```

- **MinIO Console:** Object stored under `transactions/<fileId>/<filename>` in the target bucket.
- **RabbitMQ Management:** `tx-sync-jobs-v2` and `tx-sync-jobs-dlq` are empty (all messages processed and acknowledged).

Account numbers are masked before persistence (`PL******3456`). See [`apps/integration-worker/README.md`](apps/integration-worker/README.md) for the masking rules.

## Configuration

Copy [`.env.example`](.env.example) to `.env` and adjust the values. The default credentials in the example file are for local development only and must never be used in production.

| Variable | Used by | Default | Notes |
| --- | --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | Docker Compose | `enterprise_sync` | Container and network name prefix. |
| `PORT` | api-gateway | `3000` | HTTP port. |
| `WORKER_PORT` | integration-worker | `3001` | Health probe HTTP port. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | postgres | from `.env.example` | Database bootstrap values. |
| `DATABASE_URL` | integration-worker | — | **Required.** `postgresql://user:pass@host:5432/db`. |
| `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` | RabbitMQ, both services | — | Broker credentials. |
| `RABBITMQ_HOST` / `RABBITMQ_PORT` | both services | `localhost` / `5672` | Gateway and worker connection parameters. |
| `RABBITMQ_VHOST` | integration-worker | `/` | Encoded into AMQP URL when not `/`. |
| `REDIS_HOST` / `REDIS_PORT` | both services | `localhost` / `6379` | Throttler backend and distributed locks. |
| `REDIS_PASSWORD` | both services | empty | Optional authentication password. |
| `REDIS_DB` | both services | `0` | Database index. |
| `S3_ENDPOINT_URL` | both services | `http://localhost:9000` | **Required.** MinIO / S3 endpoint. |
| `S3_REGION` | both services | `eu-central-1` | **Required.** S3 region identifier. |
| `S3_BUCKET_NAME` | both services | `transactions-bucket` | **Required for api-gateway.** Worker falls back to event `bucket`, then `S3_BUCKET`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | both services | empty | Standard AWS IAM credentials. Fall back to `MINIO_ROOT_*` when omitted. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO fallback | `admin` / `password` | Local fallback credentials. |
| `DEV_SECRET_TOKEN` | api-gateway | — | **Required.** Compared against `clientSecret`. |
| `EXPECTED_CLIENT_ID` | api-gateway | `admin-client` | Client ID accepted by `/auth/login`. |
| `JWT_SECRET` | api-gateway | — | **Required.** Signs and verifies JWT tokens. |
| `BATCH_SIZE` | integration-worker | `1000` | Number of rows per `createMany` batch. |

## Tests

```bash
# Unit tests across workspace
pnpm -r test

# Code coverage reports
pnpm --filter api-gateway test:cov
pnpm --filter integration-worker test:cov

# E2E test suites (Docker infrastructure required)
pnpm --filter api-gateway test:e2e
pnpm --filter integration-worker test:e2e
```

| Suite | Scope | Requirements |
| --- | --- | --- |
| `api-gateway test` | Controller unit tests. | None (runs in isolation). |
| `api-gateway test:e2e` | Health probes, JWT login, 401 unauthorized checks, and valid-token guard authorization. | RabbitMQ and Redis reachable (`AppModule` connects on init). |
| `integration-worker test` | PII masking, Zod schema validation, poison pill isolation, and batch chunking. | None (runs in isolation). |
| `integration-worker test:e2e` | Full flow: S3 stream → Zod validation → PII masking → Prisma batch persistence. | Docker infrastructure running (`PostgreSQL`, `RabbitMQ`, `Redis`, `MinIO`). |

Worker E2E is **destructive** to local test state: it clears `IntegrationJob` and `TransactionLog` tables, flushes Redis DB `0`, and purges RabbitMQ queues before execution. Do not run it against shared environments.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module ...\scripts\generate-dummy.js` | The generator script is located at the repository root. Run `node generate-dummy.js` directly. |
| `NoSuchBucket` on upload | Create the bucket specified in `S3_BUCKET_NAME` via the MinIO Console. |
| `401 Invalid client credentials` | `clientId` does not match `EXPECTED_CLIENT_ID` (default `admin-client`) or `clientSecret` does not match `DEV_SECRET_TOKEN` defined in `.env`. |
| `400 Checksum mismatch` | `X-Expected-Hash` does not match the computed SHA-256 of the payload. |
| `503 System temporarily unavailable` | RabbitMQ publication failed; the partial S3 object was rolled back. |
| Worker readiness probe returns `503` | RabbitMQ is disconnected or `DATABASE_URL` is unreachable. |
| `EADDRINUSE` | Port 3000 or 3001 is already in use by another process. |

## Further documentation

- [API Gateway](apps/api-gateway/README.md) — authentication, streaming uploads, event publication, and health probes.
- [Integration Worker](apps/integration-worker/README.md) — queue processing, validation, masking, persistence, and error handling.
- [Shared library](libs/shared/README.md) — logging and correlation-ID support shared by both services.
