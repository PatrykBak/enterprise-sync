# Integration Worker

Background asynchronous processing worker for the Enterprise Sync system.

## Responsibilities
- Consuming file upload events from RabbitMQ queue (`tx-sync-jobs-v2`).
- Distributed concurrency control and deduplication using Redis distributed locks (`integration:tx-sync:lock:<tenantId>:<hash>`).
- Streaming NDJSON data directly from MinIO using Node.js readline streams to prevent memory leaks.
- Runtime data validation using Zod (`RawTransactionSchema`) and PII masking for account numbers.
- Transactional batch persistence into PostgreSQL via Prisma ORM (`BATCH_SIZE` chunks).
- Error handling with Poison Pill isolation, Dead Letter Queue (DLQ) routing, and Graceful Shutdown on SIGTERM.

## Health Probes
- `GET /health/liveness` — Verifies worker process availability (port 3001).
- `GET /health/readiness` — Verifies connectivity to RabbitMQ and PostgreSQL.
