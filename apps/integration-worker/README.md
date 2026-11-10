# Integration Worker

Background asynchronous processing worker for the Enterprise Sync system. It consumes upload events, streams the referenced NDJSON file from MinIO, validates and masks records, and persists them to PostgreSQL in batches.

## Responsibilities

- Consuming file upload events from the RabbitMQ queue `tx-sync-jobs-v2`.
- Distributed concurrency control and deduplication using Redis locks (`integration:tx-sync:lock:<tenantId>:<hash>`).
- Streaming NDJSON from MinIO with Node.js `readline` to keep memory usage constant.
- Runtime validation with Zod (`RawTransactionSchema`) and PII masking of account numbers.
- Transactional batch persistence via Prisma (`BATCH_SIZE` chunks).
- Poison-pill isolation, Dead Letter Queue (DLQ) routing, retries, and graceful shutdown.

## Message topology

```text
integration.events (topic, durable)
  └─ transaction.file.uploaded ─▶ tx-sync-jobs-v2 (durable, prefetch=1)
                                        │ on rejection
                                        ▼
                         integration.events.dlx (topic)
                                        └─▶ tx-sync-jobs-dlq (durable)
```

The worker declares this topology on startup. Event payload:

| Field | Required | Notes |
| --- | --- | --- |
| `fileId` | **yes** | UUID. Also used as the `IntegrationJob` id. |
| `objectKey` | **yes** | S3 object key (`transactions/<fileId>/<fileName>`). |
| `bucket` | no | Falls back to `S3_BUCKET_NAME`, then `S3_BUCKET`, then `transactions-bucket`. |
| `expectedHash` | **yes** | SHA-256 of the file; used for deduplication and the Redis lock key. |
| `correlationId` | **yes** | Added to every log line for the job. |
| `tenantId` | **yes** | Part of the Redis lock key. |
| `messageId` | no | Informational. |

Invalid or missing fields are a fatal error and route the message to the DLQ.

## Processing flow

1. Validate the message payload with Zod.
2. Acquire the Redis lock `integration:tx-sync:lock:<tenantId>:<expectedHash>` using `SET NX EX 7200`.
   - `ACQUIRED`: continue processing.
   - `COLLISION` + `COMPLETED`: acknowledge and drop the duplicate.
   - `COLLISION` + `PROCESSING`: wait 1 s, then requeue.
   - `COLLISION` + `UNKNOWN`: route to the DLQ.
3. Upsert `IntegrationJob` to `PROCESSING` (skipped when the stored status is already `COMPLETED`).
4. Open a `GetObject` stream, split it with `readline` (CRLF aware, blank lines skipped).
5. For every line: parse JSON, validate with `RawTransactionSchema`, mask accounts, add to the batch. Invalid lines are logged with their line number only (no record contents) and skipped (poison-pill isolation) without failing the whole file.
6. Flush every `BATCH_SIZE` rows with `createMany({ skipDuplicates: true })`.
7. Mark `IntegrationJob` as `COMPLETED`, set the Redis lock value to `COMPLETED` with a TTL of 604800 seconds (7 days), and acknowledge the message.

### Error handling

- Transient errors (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`) are requeued after a 1 s delay.
- Fatal errors and already-redelivered messages are routed to the DLQ; the job is marked `FAILED` and the lock is released.
- Fatal errors include `SyntaxError`, invalid JSON/schema, `NotFound` / `NoSuchKey` / `404`, `ZodError`, and Prisma validation errors.
- A message is only processed by one consumer at a time (`prefetch=1`).
- On `SIGTERM`, the consumer stops accepting messages, waits up to 15 s for the current job, then closes the channel and connection.

## PII masking

`maskAccount` keeps the first 2 characters and the last 4, replacing the middle with `******`. Accounts with 6 or fewer characters are fully masked:

```text
PL12345678901234567890123456 → PL******3456
DE89370400440532013000       → DE******3000
ABC123                      → ******   (accounts with <= 6 characters are fully masked)
```

Masked values are the only ones persisted to `TransactionLog`. Sender and receiver names are not stored.

## Persistence model

```prisma
enum JobStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

model IntegrationJob {
  id     String    @id @default(uuid()) @db.Uuid
  fileId String    @unique
  status JobStatus @default(PENDING)
}

model TransactionLog {
  id              String   @id @default(uuid()) @db.Uuid
  jobId           String   @db.Uuid
  transactionId   String
  amount          Decimal  @db.Decimal(18, 2)
  currency        String
  senderAccount   String
  receiverAccount String
  timestamp       DateTime

  @@unique([jobId, transactionId])
}
```

`@@unique([jobId, transactionId])` plus `skipDuplicates` makes batch retries idempotent.

## Configuration

Variables are loaded from `.env` at the repository root (or `apps/integration-worker/.env`). See the [root configuration table](../../README.md#configuration) for the full list shared with the gateway.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `WORKER_PORT` | no | `3001` | HTTP port for health probes. |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string. |
| `RABBITMQ_HOST` / `RABBITMQ_PORT` | no | `localhost` / `5672` | Broker address. |
| `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` | **yes** | — | Broker credentials from `.env`. |
| `RABBITMQ_VHOST` | no | `/` | Encoded into the AMQP URL when not `/`. |
| `REDIS_HOST` / `REDIS_PORT` | no | `localhost` / `6379` | Lock storage. |
| `REDIS_PASSWORD` | no | empty | Optional. |
| `REDIS_DB` | no | `0` | Lock database index. |
| `S3_ENDPOINT_URL` | **yes** | — | MinIO endpoint. |
| `S3_REGION` | **yes** | — | Any region value works with MinIO. |
| `S3_BUCKET_NAME` | no | — | Used when the event omits `bucket`; the bucket must already exist. |
| `S3_BUCKET` | no | `transactions-bucket` | Last-resort fallback when both the event and `S3_BUCKET_NAME` are empty. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | empty | Fall back to `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | no | — | Fallback S3 credentials. |
| `BATCH_SIZE` | no | `1000` | Rows per `createMany` batch. |

Redis lock TTLs are constants in `src/redis/redis.constants.ts`:

- `LOCK_TTL_SECONDS = 7200` (processing lock).
- `FINALIZE_TTL_SECONDS = 604800` (completed/failed marker).

## Running locally

Start the full stack with `bash start-dev.sh` as described in the [root README](../../README.md#quick-start). To run only this service after the infrastructure is up:

```bash
pnpm --filter integration-worker prisma:generate
pnpm --filter integration-worker prisma:push
pnpm --filter "@enterprise-sync/shared" build
pnpm --filter integration-worker start:dev
```

PostgreSQL, RabbitMQ, Redis, and MinIO must be reachable. The target bucket (from the event, `S3_BUCKET_NAME`, or the `S3_BUCKET` fallback) must exist before a job can read from it.

## Health probes

| Endpoint | Checks |
| --- | --- |
| `GET /health/liveness` | Process availability. Always `{ "status": "ok", "timestamp": "..." }`. |
| `GET /health/readiness` | RabbitMQ connection and `SELECT 1` against PostgreSQL. Returns `503` with `details` when either is down. |

Redis is not part of the readiness check.

## Tests

```bash
# Unit tests
pnpm --filter integration-worker test

# Coverage report
pnpm --filter integration-worker test:cov

# E2E tests
pnpm --filter integration-worker test:e2e
```

- `test` runs Jest unit tests in `src/**/*.spec.ts` (schema validation, masking and batch flushing) and needs no infrastructure. The package uses `--passWithNoTests`, so a missing spec exits successfully.
- `test:e2e` boots `AppModule`, uploads a 5-record NDJSON file to MinIO, publishes a real RabbitMQ message, polls until the job is `COMPLETED`, and asserts 5 persisted rows with masked accounts plus both health probes.

E2E prerequisites:

1. Start the Docker infrastructure (`docker compose up -d`).
2. Apply the schema: `pnpm --filter integration-worker prisma:push`.
3. Make sure ports `5432`, `5672`, `6379` and `9000` are free and use the default local credentials.

E2E is **destructive** and hardcodes local credentials (`admin` / `password`): it creates `transactions-bucket`, deletes all `TransactionLog` and `IntegrationJob` rows, flushes Redis DB `0`, and purges `tx-sync-jobs-v2` and `tx-sync-jobs-dlq` before each test. Do not run it against a shared database or broker.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Startup fails: `DATABASE_URL` / S3 config missing | Fill in the required variables from `.env.example`. |
| Readiness returns `503` with `database: false` | PostgreSQL is down or `DATABASE_URL` is wrong. |
| Readiness returns `503` with `rabbitmq: false` | Broker is down or the connection dropped. |
| Job stays `PROCESSING` | The message was requeued after a transient error, or a previous consumer crashed before the 7200 s lock TTL expired. Inspect worker logs and RabbitMQ. |
| Job ends `FAILED` and `tx-sync-jobs-dlq` grows | The payload or file is invalid (missing fields, bad JSON, `NoSuchKey`). Inspect the DLQ message and the referenced object. |
| No rows persisted but the job completed | All lines failed Zod validation and were skipped as poison pills. Check worker warnings for the line number; record contents are intentionally not logged. |
