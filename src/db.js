import pg from "pg";
import config from "./config.js";
import { logger } from "./services/logger.js";

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL non configurata");
}

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  logger.error("Unexpected error on idle client", { error: err.message });
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function getClient() {
  return pool.connect();
}

export default pool;
