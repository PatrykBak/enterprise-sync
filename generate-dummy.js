const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const crypto = require("crypto");

const SIZE_IN_MB = 2000;
const TARGET_SIZE_BYTES = SIZE_IN_MB * 1024 * 1024;
const FILE_PATH = path.join(__dirname, `dummy-${SIZE_IN_MB}mb.ndjson`);
console.log(`Generating ${SIZE_IN_MB}MB dummy file...`);

const hasher = crypto.createHash("sha256");

// Generates data chunks sequentially to keep memory footprint low
async function* generateData(targetBytes) {
  let bytesWritten = 0;
  let index = 0;
  const baseTimestamp = Date.now();

  while (bytesWritten < targetBytes) {
    index++;
    // Simulate chronological events spaced 1 minute apart
    const simulatedDate = new Date(baseTimestamp + index * 60000);

    const record =
      JSON.stringify({
        transactionId: `tx-${index}`,
        amount: +(Math.random() * 1000).toFixed(2),
        currency: "USD",
        timestamp: simulatedDate.toISOString(),
      }) + "\n";

    const buffer = Buffer.from(record, "utf8");
    hasher.update(buffer);
    bytesWritten += buffer.length;

    yield buffer;
  }
}

async function run() {
  const writeStream = fs.createWriteStream(FILE_PATH);

  writeStream.on("error", (err) => {
    console.error("[Error] File write stream failed:", err.message);
    process.exit(1);
  });

  try {
    await pipeline(generateData(TARGET_SIZE_BYTES), writeStream);
    console.log(
      `[Success] Generated ${SIZE_IN_MB}MB dummy file at ${FILE_PATH}`,
    );

    const fileHash = hasher.digest("hex");
    console.log(`[Hash] SHA256: ${fileHash}\n`);
    console.log(`Use the following curl command to test the upload:`);
    console.log(`curl -X POST http://localhost:3000/api/sync-transactions \\`);
    console.log(`  -H "Authorization: Bearer dev-secret-token" \\`);
    console.log(
      `  -H "X-Correlation-ID: 123e4567-e89b-12d3-a456-426614174000" \\`,
    );
    console.log(`  -H "X-Tenant-ID: test-tenant-1" \\`);
    console.log(`  -H "X-Expected-Hash: ${fileHash}" \\`);
    console.log(
      `  -F "file=@dummy-${SIZE_IN_MB}mb.ndjson;type=application/x-ndjson"`,
    );
  } catch (err) {
    console.error("[Error] Pipeline failed during execution:", err.message);
  }
}

run();
