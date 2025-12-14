/**
 * Redis Connection Configuration for BullMQ
 */

const Redis = require("ioredis");

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || "";
const REDIS_DB = process.env.REDIS_DB || 0;
const REDIS_URL = process.env.REDIS_URL;

/**
 * Create and export Redis connection options for BullMQ
 */
const redisConnection = REDIS_URL
  ? REDIS_URL
  : {
      host: REDIS_HOST,
      port: parseInt(REDIS_PORT, 10),
      password: REDIS_PASSWORD || undefined,
      db: parseInt(REDIS_DB, 10),
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    };

/**
 * Test Redis connection
 */
async function testRedisConnection() {
  const client = new Redis(redisConnection);
  try {
    await client.ping();
    console.log("[Redis] ✓ Connection successful");
    await client.quit();
    return true;
  } catch (error) {
    console.error("[Redis] ✗ Connection failed:", error.message);
    await client.quit();
    return false;
  }
}

module.exports = {
  redisConnection,
  testRedisConnection,
};
