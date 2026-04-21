## Description

API Gateway for the Enterprise Sync system. This service is the main entry point for data synchronization. Its primary responsibilities include:
- Authenticating and authorizing incoming requests.
- Handling large file uploads by streaming them directly to an S3-compatible object storage (MinIO) to minimize memory usage.
- Verifying file integrity using SHA256 checksums.
- Publishing events to a RabbitMQ message broker to trigger asynchronous processing by worker services.

## Testing the Sync Transactions Endpoint (Large File Streaming)

To test the large file streaming endpoint (`POST /api/sync-transactions`), which features efficient, low-memory streaming, follow these steps:

### 1. Start the Development Environment
From the root of the project, run the main infrastructure script. This will start all required Docker containers (MinIO, Postgres, RabbitMQ) and the API Gateway server:
```bash
$ bash start-dev.sh
```

### 2. Prepare the MinIO Bucket
Before uploading, the target bucket must exist in the Object Storage:
1. Open the MinIO Console in your browser: `http://localhost:9001`
2. Log in with the credentials defined in your `.env` file (default: `admin` / `password`).
3. Navigate to **Buckets** and create a new bucket named `transactions-bucket`.

### 3. Generate a Dummy Payload
Generate a large test NDJSON file (e.g., 2000MB) using the utility script. The script will also calculate the file's SHA256 hash and print the complete `curl` command required for the next step.
```bash
$ node generate-dummy.js
```

### 4. Execute the Test Request
Copy the `curl` command that was printed to your console in the previous step and execute it. It includes all required headers for authentication, correlation, tenancy, and integrity verification.

The command will look similar to the one below:
```bash
$ curl -X POST http://localhost:3000/api/sync-transactions \
  -H "Authorization: Bearer dev-secret-token" \
  -H "X-Correlation-ID: 123e4567-e89b-12d3-a456-426614174000" \
  -H "X-Tenant-ID: test-tenant-1" \
  -H "X-Expected-Hash: 9670671415ff6efe81b936aedca641c519ad0c1399ad745e98d707f145e841c3" \
  -F "file=@dummy-2000mb.ndjson;type=application/x-ndjson"
```

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start
```

## Run tests

```bash
# unit tests
$ pnpm run test
```