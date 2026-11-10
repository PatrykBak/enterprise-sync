const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const crypto = require("crypto");

const SIZE_IN_MB = 400;
const TARGET_SIZE_BYTES = SIZE_IN_MB * 1024 * 1024;
const FILE_PATH = path.join(__dirname, `dummy-${SIZE_IN_MB}mb.ndjson`);

async function* generateData(targetBytes, hasher) {
  let bytesWritten = 0;
  let index = 0;
  const baseTimestamp = Date.now();

  while (bytesWritten < targetBytes) {
    index++;
    const simulatedDate = new Date(baseTimestamp + index * 60000);

    const record =
      JSON.stringify({
        transactionId: `tx-${index}`,
        amount: (Math.random() * 1000 + 0.01).toFixed(2),
        currency: "USD",
        senderName: `Sender ${index}`,
        receiverName: `Receiver ${index}`,
        senderAccount: `PL12345678901234567890${String(index).padStart(4, "0")}`,
        receiverAccount: `PL98765432109876543210${String(index).padStart(4, "0")}`,
        timestamp: simulatedDate.toISOString(),
      }) + "\n";

    const buffer = Buffer.from(record, "utf8");
    hasher.update(buffer);
    bytesWritten += buffer.length;

    yield buffer;
  }
}

async function run() {
  console.log(`Generating ${SIZE_IN_MB}MB dummy file at: ${FILE_PATH}`);

  if (fs.existsSync(FILE_PATH)) {
    fs.unlinkSync(FILE_PATH);
  }

  const hasher = crypto.createHash("sha256");
  const writeStream = fs.createWriteStream(FILE_PATH, { flags: "w" });

  try {
    await pipeline(generateData(TARGET_SIZE_BYTES, hasher), writeStream);
    const fileHash = hasher.digest("hex");

    console.log(`[Success] Generated ${SIZE_IN_MB}MB dummy file.`);
    console.log(`[Hash] SHA256: ${fileHash}\n`);
    console.log("1. Obtain JWT Access Token:");
    console.log(
      'curl -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d \'{"clientId":"admin-client","clientSecret":"dev-secret-token"}\'\n',
    );
    console.log("2. Upload file using the received <ACCESS_TOKEN>:");
    console.log("curl -X POST http://localhost:3000/api/sync-transactions \\");
    console.log('  -H "Authorization: Bearer <ACCESS_TOKEN>" \\');
    console.log(
      '  -H "X-Correlation-ID: 123e4567-e89b-12d3-a456-426614174000" \\',
    );
    console.log('  -H "X-Tenant-ID: test-tenant-1" \\');
    console.log(`  -H "X-Expected-Hash: ${fileHash}" \\`);
    console.log(
      `  -F "file=@dummy-${SIZE_IN_MB}mb.ndjson;type=application/x-ndjson"`,
    );
  } catch (err) {
    console.error("[Error] Failed to generate dummy file:", err.message);
    process.exit(1);
  }
}

run();
