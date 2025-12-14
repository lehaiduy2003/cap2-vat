/**
 * Redis Connection Configuration for BullMQ
 */

const Redis = require("ioredis");
dotenv = require("dotenv");
dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || "";
const REDIS_DB = process.env.REDIS_DB || 0;
const REDIS_URL = process.env.REDIS_URL;

/**
 * Create and export Redis connection options for BullMQ
 */
let redisConnection;

if (REDIS_URL) {
  // Parse REDIS_URL for connection options
  const url = new URL(REDIS_URL);
  redisConnection = {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
    password: url.password || undefined,
    db: parseInt(REDIS_DB, 10),
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  };
  console.log(
    "config/redis.js - Using REDIS_URL with host:",
    redisConnection.host,
    "port:",
    redisConnection.port
  );
} else {
  redisConnection = {
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
  console.log(
    "config/redis.js - Using individual env vars with host:",
    REDIS_HOST,
    "port:",
    REDIS_PORT
  );
}

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
