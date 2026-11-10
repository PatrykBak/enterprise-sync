# API Gateway

HTTP entry point for the Enterprise Sync system. The gateway authenticates clients, streams NDJSON uploads directly to MinIO, verifies their SHA-256 checksums, and publishes processing events to RabbitMQ.

## Responsibilities

- Authenticating clients and issuing JWT access tokens.
- Authorizing synchronization requests with the `admin` role.
- Streaming multipart uploads to MinIO with Busboy without buffering whole files in memory.
- Calculating SHA-256 checksums while streaming and rejecting mismatched uploads.
- Publishing persistent events to the `integration.events` topic exchange.
- Removing uploaded objects when checksum verification or event publication fails.
- Applying Redis-backed rate limiting and exposing health probes.

## API endpoints

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/login` | Public | Exchanges client credentials for a JWT valid for 1 hour. |
| `POST` | `/api/sync-transactions` | JWT with the `admin` role | Streams an NDJSON file to MinIO and schedules processing. |
| `GET` | `/health/liveness` | Public | Checks HTTP process availability. |
| `GET` | `/health/readiness` | Public | Checks RabbitMQ and Redis connectivity. |

For a complete upload example, see the [end-to-end walkthrough](../../README.md#end-to-end-upload-walkthrough) in the root README.

## Upload flow

```text
Client ─ multipart/form-data ─▶ API Gateway ─ stream (Busboy) ─▶ MinIO (S3)
                                    │
                                    ├─▶ SHA-256 integrity check
                                    │
                                    ▼
                       RabbitMQ: integration.events
                       routing key: transaction.file.uploaded
```

1. Validate the multipart content type, `X-Tenant-ID`, and `X-Expected-Hash` headers.
2. Accept one file with a maximum size of 2 GB and one of the supported MIME types:
   - `application/x-ndjson`
   - `application/json`
   - `application/octet-stream`
3. Generate a UUID `fileId` and sanitize the original filename.
4. Stream the file to `transactions/<fileId>/<fileName>` while calculating its SHA-256 checksum.
5. Compare the calculated checksum with `X-Expected-Hash`. A `sha256:` prefix is accepted and stripped before verification.
6. Publish a persistent event to RabbitMQ through a confirm channel.
7. Return `202 Accepted` with the correlation ID:

```json
{
  "status": "accepted",
  "correlationId": "123e4567-e89b-12d3-a456-426614174000"
}
```

The `X-Correlation-ID` request header is optional. When omitted, the gateway generates a UUID and returns it in both the response body and the `X-Correlation-ID` response header.

### Published event

| Field | Description |
| --- | --- |
| `messageId` | Generated event UUID. |
| `fileId` | Generated file UUID, also used by the worker as the job ID. |
| `objectKey` | S3 object key: `transactions/<fileId>/<fileName>`. |
| `bucket` | Bucket configured through `S3_BUCKET_NAME`. |
| `expectedHash` | Normalized SHA-256 computed during streaming (matches `X-Expected-Hash` after validation). |
| `correlationId` | Correlation ID propagated to logs and the worker. |
| `tenantId` | Tenant identifier supplied in `X-Tenant-ID`. |
| `uploadedAt` | ISO 8601 publication timestamp. |

### Failure handling

| Situation | Response | Cleanup behavior |
| --- | --- | --- |
| Missing or invalid authentication | `401 Unauthorized` | No upload starts. |
| Authenticated user without the `admin` role | `403 Forbidden` | No upload starts. |
| Missing headers, file, or unsupported MIME type | `400 Bad Request` | No event is published. |
| File larger than 2 GB | `413 Payload Too Large` | The multipart upload is aborted. |
| SHA-256 mismatch | `400 Bad Request` | The uploaded object is deleted when possible. |
| RabbitMQ publication failure | `503 Service Unavailable` | The gateway attempts to delete the uploaded object. |
| Rate limit exceeded | `429 Too Many Requests` | The request is rejected before processing. |

The global throttler allows 10 requests per 60 seconds and stores its state in Redis. Health probes are excluded from throttling.

## Configuration

Variables are loaded from `.env` in the service directory or the repository root. See the [root configuration table](../../README.md#configuration) for the complete shared list.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | HTTP server port. |
| `DEV_SECRET_TOKEN` | **yes** | — | Secret compared with `clientSecret` during login. |
| `EXPECTED_CLIENT_ID` | no | `admin-client` | Client ID accepted by `/auth/login`. |
| `JWT_SECRET` | **yes** | — | Secret used to sign and verify JWT tokens. |
| `RABBITMQ_HOST` / `RABBITMQ_PORT` | **yes** | — | RabbitMQ address. |
| `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` | **yes** | — | RabbitMQ credentials. |
| `REDIS_HOST` / `REDIS_PORT` | no | `localhost` / `6379` | Redis address for rate limiting and readiness checks. |
| `REDIS_PASSWORD` | no | empty | Optional Redis password. |
| `REDIS_DB` | no | `0` | Redis database index. |
| `S3_ENDPOINT_URL` | **yes** | — | MinIO or S3 endpoint. |
| `S3_REGION` | **yes** | — | S3 region identifier. |
| `S3_BUCKET_NAME` | **yes** | — | Existing destination bucket. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | empty | Fall back to `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | conditional | — | Required when AWS credentials are not set. |

The gateway does not create the destination bucket automatically.

## Running locally

Start the full stack with `bash start-dev.sh`, as described in the [root README](../../README.md#quick-start). To run only the gateway after the infrastructure is available:

```bash
pnpm --filter "@enterprise-sync/shared" build
pnpm --filter api-gateway start:dev
```

RabbitMQ, Redis, and MinIO must be reachable. The bucket configured in `S3_BUCKET_NAME` must already exist.

## Health probes

| Endpoint | Success response | Dependency checks |
| --- | --- | --- |
| `GET /health/liveness` | `200 OK` with `{ "status": "ok" }` | None. |
| `GET /health/readiness` | `200 OK` with dependency details | RabbitMQ connection state and Redis `PING`; returns `503 Service Unavailable` when either check fails. |

## Tests

```bash
# Unit tests
pnpm --filter api-gateway test

# Coverage report
pnpm --filter api-gateway test:cov

# E2E tests
pnpm --filter api-gateway test:e2e
```

- Unit tests cover the controller without external infrastructure.
- E2E tests cover liveness, JWT login, invalid credentials, rejection of unauthenticated synchronization requests, and confirmation that a valid token passes the auth guard. RabbitMQ and Redis must be reachable because the suite boots `AppModule`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Startup fails with a missing configuration error | Check the required variables in `.env`; see `.env.example`. |
| `401 Invalid client credentials` | Ensure `clientId` matches `EXPECTED_CLIENT_ID` (default `admin-client`) and `clientSecret` matches `DEV_SECRET_TOKEN`. |
| `401 Unauthorized` on upload | Provide a valid `Authorization: Bearer <token>` header. |
| `400 Checksum mismatch` | Recalculate the SHA-256 hash of the exact uploaded bytes. |
| `NoSuchBucket` or an S3 upload error | Create the bucket from `S3_BUCKET_NAME` and verify the endpoint and credentials. |
| Readiness returns `503` with `rabbitmq: false` | Check the broker address, credentials, and connection logs. |
| Readiness returns `503` with `redis: false` | Check Redis connectivity, credentials, and `REDIS_DB`. |
| `503 System temporarily unavailable` | RabbitMQ publication failed; inspect the gateway logs and rollback result. |
| `EADDRINUSE` | Port `3000` is already in use; stop the other process or change `PORT`. |
