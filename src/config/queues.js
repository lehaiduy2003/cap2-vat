/**
 * BullMQ Queue Definitions
 */

const { Queue } = require("bullmq");
const { redisConnection } = require("./redis");

/**
 * Document Processing Queue
 * Handles asynchronous RAG document processing
 */
const documentProcessingQueue = new Queue("document-processing", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times on failure
    backoff: {
      type: "exponential",
      delay: 5000, // Start with 5 seconds delay
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000, // Keep max 1000 completed jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

/**
 * Document Deletion Queue
 * Handles asynchronous document deletion from Elasticsearch
 */
const documentDeletionQueue = new Queue("document-deletion", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times on failure
    backoff: {
      type: "exponential",
      delay: 2000, // Start with 2 seconds delay
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 500, // Keep max 500 completed jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

// Event listeners for monitoring
documentProcessingQueue.on("error", (error) => {
  console.error("[Processing Queue Error]", error);
});

documentDeletionQueue.on("error", (error) => {
  console.error("[Deletion Queue Error]", error);
});

module.exports = {
  documentProcessingQueue,
  documentDeletionQueue,
};
