import { fullExport } from "../src/services/static-export.js";

async function main() {
  console.log("=== Export pagine statiche ===");
  const result = await fullExport();
  console.log(`\nTotale: ${result.totalExported} pagine esportate${result.totalErrors ? `, ${result.totalErrors} errori` : ""}`);
  console.log(`Symlink: ${result.symlinkCount} creati/aggiornati`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
