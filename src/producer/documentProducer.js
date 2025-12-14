/**
 * Document Processing Producer
 * Adds document processing jobs to the BullMQ queue
 */

const { documentProcessingQueue, documentDeletionQueue } = require("../config/queues");

/**
 * Add a document processing job to the queue
 * @param {number} documentId - Document ID
 * @param {string} uploadUrl - URL to fetch the document
 * @param {object} metadata - Document metadata
 * @returns {Promise<Job>} - BullMQ job object
 */
async function addDocumentProcessingJob(documentId, uploadUrl, metadata = {}) {
  try {
    const job = await documentProcessingQueue.add(
      `process-document-${documentId}`,
      {
        documentId,
        uploadUrl,
        metadata: {
          title: metadata.title,
          original_filename: metadata.original_filename,
          owner_id: metadata.owner_id,
          property_id: metadata.property_id,
          description: metadata.description,
          price: metadata.price,
          room_size: metadata.room_size,
          address_details: metadata.address_details,
        },
      },
      {
        jobId: `doc-${documentId}-${Date.now()}`, // Unique job ID
        priority: metadata.priority || 10, // Lower number = higher priority
      }
    );

    console.log(
      `[Producer] ✓ Added document ${documentId} to processing queue (Job ID: ${job.id})`
    );
    return job;
  } catch (error) {
    console.error(
      `[Producer] ✗ Failed to add document ${documentId} to processing queue:`,
      error.message
    );
    throw error;
  }
}

/**
 * Add a document deletion job to the queue
 * @param {number} documentId - Document ID to delete
 * @returns {Promise<Job>} - BullMQ job object
 */
async function addDocumentDeletionJob(documentId) {
  try {
    const job = await documentDeletionQueue.add(
      `delete-document-${documentId}`,
      {
        documentId,
      },
      {
        jobId: `doc-delete-${documentId}-${Date.now()}`, // Unique job ID
        priority: 5, // Higher priority for deletions
      }
    );

    console.log(`[Producer] ✓ Added document ${documentId} to deletion queue (Job ID: ${job.id})`);
    return job;
  } catch (error) {
    console.error(
      `[Producer] ✗ Failed to add document ${documentId} to deletion queue:`,
      error.message
    );
    throw error;
  }
}

/**
 * Get job status by document ID
 * @param {number} documentId - Document ID
 * @returns {Promise<object>} - Job status information
 */
async function getDocumentJobStatus(documentId) {
  try {
    const jobs = await documentProcessingQueue.getJobs(["active", "waiting", "delayed", "failed"]);
    const job = jobs.find((j) => j.data.documentId === documentId);

    if (!job) {
      return { found: false };
    }

    const state = await job.getState();
    const progress = job.progress;

    return {
      found: true,
      jobId: job.id,
      state,
      progress,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      failedReason: job.failedReason,
    };
  } catch (error) {
    console.error(`[Producer] Error getting job status for document ${documentId}:`, error.message);
    throw error;
  }
}

module.exports = {
  addDocumentProcessingJob,
  addDocumentDeletionJob,
  getDocumentJobStatus,
};
