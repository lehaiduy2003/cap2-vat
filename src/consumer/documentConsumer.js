/**
 * Document Processing Consumer (BullMQ Worker)
 * Processes RAG document jobs from the queue
 */

const { Worker } = require("bullmq");
const { redisConnection } = require("../config/redis");
const { processDocumentFromUrl, deleteDocument } = require("../ragClient");
const { pool } = require("../config/db");

/**
 * Job processor function for document processing
 * @param {Job} job - BullMQ job object
 */
async function processDocumentJob(job) {
  const { documentId, uploadUrl, metadata } = job.data;

  console.log(`[Worker] Processing document ${documentId} (Job ID: ${job.id})`);

  try {
    // Update document status to processing
    await pool.query(
      `UPDATE documents 
       SET status = 'processing', 
           processing_started_at = NOW() 
       WHERE id = $1`,
      [documentId]
    );

    // Call RAG service to process the document
    const result = await processDocumentFromUrl(documentId, uploadUrl, metadata);

    console.log(`[Worker] ✓ Document ${documentId} processed successfully`);

    // Note: The RAG service will call back to update the status via PATCH /api/v1/documents/:id
    // So we don't update to 'completed' here

    return {
      success: true,
      documentId,
      message: result.message || "Processing completed",
    };
  } catch (error) {
    console.error(`[Worker] ✗ Document ${documentId} processing failed:`, error.message);

    // Update document status to failed
    await pool.query(
      `UPDATE documents 
       SET status = 'failed', 
           error_message = $1,
           processing_completed_at = NOW()
       WHERE id = $2`,
      [error.message, documentId]
    );

    // Re-throw to let BullMQ handle retries
    throw error;
  }
}

/**
 * Job processor function for document deletion
 * @param {Job} job - BullMQ job object
 */
async function deleteDocumentJob(job) {
  const { documentId } = job.data;

  console.log(`[Worker] Deleting document chunks for ${documentId} (Job ID: ${job.id})`);

  try {
    // Call RAG service to delete document chunks from Elasticsearch
    await deleteDocument(documentId);

    console.log(`[Worker] ✓ Document chunks ${documentId} deleted successfully from Elasticsearch`);

    return {
      success: true,
      documentId,
      message: "Document chunks deleted from Elasticsearch",
    };
  } catch (error) {
    console.error(`[Worker] ✗ Document ${documentId} deletion failed:`, error.message);

    // Re-throw to let BullMQ handle retries
    throw error;
  }
}

/**
 * Create and start the document processing worker
 */
function createDocumentProcessingWorker() {
  const worker = new Worker("document-processing", processDocumentJob, {
    connection: redisConnection,
    concurrency: 5, // Process up to 5 jobs concurrently
    limiter: {
      max: 10, // Max 10 jobs
      duration: 1000, // per second
    },
  });

  // Event listeners
  worker.on("completed", (job, result) => {
    console.log(`[Processing Worker] Job ${job.id} completed:`, result.message);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `[Processing Worker] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`,
      error.message
    );
  });

  worker.on("error", (error) => {
    console.error("[Processing Worker] Error:", error);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[Processing Worker] Job ${jobId} stalled`);
  });

  console.log("[Worker] Document processing worker started");

  return worker;
}

/**
 * Create and start the document deletion worker
 */
function createDocumentDeletionWorker() {
  const worker = new Worker("document-deletion", deleteDocumentJob, {
    connection: redisConnection,
    concurrency: 3, // Process up to 3 deletion jobs concurrently
    limiter: {
      max: 5, // Max 5 jobs
      duration: 1000, // per second
    },
  });

  // Event listeners
  worker.on("completed", (job, result) => {
    console.log(`[Deletion Worker] Job ${job.id} completed:`, result.message);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `[Deletion Worker] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`,
      error.message
    );
  });

  worker.on("error", (error) => {
    console.error("[Deletion Worker] Error:", error);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[Deletion Worker] Job ${jobId} stalled`);
  });

  console.log("[Worker] Document deletion worker started");

  return worker;
}

module.exports = {
  createDocumentProcessingWorker,
  createDocumentDeletionWorker,
  processDocumentJob,
  deleteDocumentJob,
};
