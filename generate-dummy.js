const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const SIZE_IN_MB = 100;
const TARGET_SIZE_BYTES = SIZE_IN_MB * 1024 * 1024;
const FILE_PATH = path.join(__dirname, `dummy-${SIZE_IN_MB}mb.ndjson`);
console.log(`Generating ${SIZE_IN_MB}MB dummy file...`);

// Generates data chunks sequentially to keep memory footprint low
async function* generateData(targetBytes) {
  let bytesWritten = 0;
  let index = 0;
  const baseTimestamp = Date.now();

  while (bytesWritten < targetBytes) {
    index++;
    // Simulate chronological events spaced 1 minute apart
    const simulatedDate = new Date(baseTimestamp + index * 60000);

    const record = JSON.stringify({
      transactionId: `tx-${index}`,
      amount: +(Math.random() * 1000).toFixed(2),
      currency: 'USD',
      timestamp: simulatedDate.toISOString(),
    }) + '\n';

    const buffer = Buffer.from(record, 'utf8');
    bytesWritten += buffer.length;
    
    yield buffer; 
  }
}

async function run() {
  const writeStream = fs.createWriteStream(FILE_PATH);

  writeStream.on('error', (err) => {
    console.error('[Error] File write stream failed:', err.message);
    process.exit(1);
  });

  try {
    await pipeline(
      generateData(TARGET_SIZE_BYTES),
      writeStream
    );
    console.log(`[Success] Generated ${SIZE_IN_MB}MB dummy file at ${FILE_PATH}`);
  } catch (err) {
    console.error('[Error] Pipeline failed during execution:', err.message);
  }
}

run();
