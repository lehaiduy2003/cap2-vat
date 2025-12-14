/**
 * Document Routes
 * Handles all document-related API endpoints
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const {
  addDocumentProcessingJob,
  addDocumentDeletionJob,
} = require("../producer/documentProducer");

// Middleware imports
const { userAuth, adminAuth } = require("../middleware/auth");

/**
 * POST /api/v1/documents
 * Create a document record and trigger RAG processing
 * Requires: x-user-id header (owner ID)
 */
router.post("/documents", userAuth, async (req, res) => {
  try {
    const ownerId = req.user_id;
    const { title, original_filename, upload_url, property_id, metadata } = req.body;

    // Validate required fields
    if (!title || !original_filename || !upload_url) {
      return res.status(400).json({
        error: "Missing required fields: title, original_filename, upload_url",
      });
    }

    // Validate URL format
    try {
      new URL(upload_url);
    } catch (err) {
      return res.status(400).json({
        error: "Invalid upload_url format",
      });
    }

    // Extract additional fields from metadata
    const description = metadata?.description || null;
    const price = metadata?.price ? parseFloat(metadata.price) : null;
    const address_details = metadata?.address_details || null;
    const room_size = metadata?.room_size ? parseInt(metadata.room_size) : null;

    // Insert document record
    const insertQuery = {
      text: `
        INSERT INTO documents (
          title, original_filename, upload_url, owner_id, property_id,
          description, price, address_details, room_size, metadata, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'processing')
        RETURNING *
      `,
      values: [
        title,
        original_filename,
        upload_url,
        ownerId.toString(),
        property_id || null,
        description,
        price,
        address_details,
        room_size,
        metadata || {},
      ],
    };

    const result = await pool.query(insertQuery);
    const document = result.rows[0];

    // Add document processing job to BullMQ queue
    try {
      await addDocumentProcessingJob(document.id, upload_url, {
        title,
        original_filename,
        owner_id: ownerId.toString(),
        property_id,
        description,
        price,
        address_details,
        room_size,
      });
    } catch (err) {
      console.error(`[Queue ERROR] Failed to add document ${document.id} to queue:`, err.message);
    }

    // Return success response immediately
    res.status(201).json({
      success: true,
      document_id: document.id,
      message: "Document created successfully. Processing started.",
      document: {
        id: document.id,
        title: document.title,
        original_filename: document.original_filename,
        upload_url: document.upload_url,
        owner_id: document.owner_id,
        property_id: document.property_id,
        status: document.status,
        created_at: document.created_at,
      },
    });
  } catch (error) {
    console.error("[DOCUMENT CREATE ERROR]", error.message);
    res.status(500).json({ error: "Failed to create document: " + error.message });
  }
});

/**
 * GET /api/v1/documents
 * Get list of documents for the authenticated owner
 * Requires: x-user-id header (owner ID)
 */
router.get("/documents", userAuth, async (req, res) => {
  try {
    const ownerId = req.user_id;
    const { property_id, status, limit } = req.query;

    let query = `
      SELECT
        id, title, original_filename, upload_url, owner_id, property_id,
        description, price, address_details, room_size,
        metadata, status, processing_started_at, processing_completed_at,
        error_message, chunk_count, created_at, updated_at
      FROM documents
      WHERE owner_id = $1
    `;
    const params = [ownerId.toString()];

    if (property_id) {
      params.push(property_id);
      query += ` AND property_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    } else {
      query += ` LIMIT 50`;
    }

    const result = await pool.query(query, params);

    res.json({
      documents: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error("[GET DOCUMENTS ERROR]", error.message);
    res.status(500).json({ error: "Failed to fetch documents: " + error.message });
  }
});

/**
 * GET /api/v1/documents/:id
 * Get a specific document by ID
 * Requires: x-user-id header (owner ID)
 */
router.get("/documents/:id", userAuth, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    const ownerId = req.user_id;

    if (isNaN(documentId)) {
      return res.status(400).json({ error: "Invalid document ID" });
    }

    const result = await pool.query(`SELECT * FROM documents WHERE id = $1 AND owner_id = $2`, [
      documentId,
      ownerId.toString(),
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    res.json({
      document: result.rows[0],
    });
  } catch (error) {
    console.error("[GET DOCUMENT ERROR]", error.message);
    res.status(500).json({ error: "Failed to fetch document: " + error.message });
  }
});

/**
 * PATCH /api/v1/documents/:id
 * Update document status and metadata (used by RAG service)
 * Requires: x-api-key header (admin access)
 */
router.patch("/documents/:id", adminAuth, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    const {
      status,
      metadata,
      error_message,
      chunk_count,
      processing_started_at,
      processing_completed_at,
    } = req.body;

    if (isNaN(documentId)) {
      return res.status(400).json({ error: "Invalid document ID" });
    }

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (metadata) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(metadata);
    }

    if (error_message !== undefined) {
      updates.push(`error_message = $${paramIndex++}`);
      values.push(error_message);
    }

    if (chunk_count !== undefined) {
      updates.push(`chunk_count = $${paramIndex++}`);
      values.push(chunk_count);
    }

    if (processing_started_at) {
      updates.push(`processing_started_at = $${paramIndex++}`);
      values.push(processing_started_at);
    }

    if (processing_completed_at) {
      updates.push(`processing_completed_at = $${paramIndex++}`);
      values.push(processing_completed_at);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(documentId);
    const query = `
      UPDATE documents
      SET ${updates.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    res.json({
      success: true,
      document: result.rows[0],
    });
  } catch (error) {
    console.error("[UPDATE DOCUMENT ERROR]", error.message);
    res.status(500).json({ error: "Failed to update document: " + error.message });
  }
});

router.delete("/documents/:id", userAuth, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id, 10);
    const ownerId = req.user_id;

    if (isNaN(documentId)) {
      return res.status(400).json({ error: "Invalid document ID" });
    }

    // Delete document record from database
    const deleteQuery = {
      text: `DELETE FROM documents WHERE id = $1 AND owner_id = $2 RETURNING *`,
      values: [documentId, ownerId.toString()],
    };

    const result = await pool.query(deleteQuery);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Document not found or not owned by user" });
    }

    // Add deletion job to queue (async - don't wait for Elasticsearch deletion)
    try {
      await addDocumentDeletionJob(documentId);
      console.log(`[DELETE] Added document ${documentId} to deletion queue`);
    } catch (err) {
      console.error(
        `[DELETE] Failed to add document ${documentId} to deletion queue:`,
        err.message
      );
      // Continue anyway - document is already deleted from database
    }

    res.json({
      success: true,
      message: "Document deleted successfully. Elasticsearch cleanup in progress.",
    });
  } catch (error) {
    console.error("[DELETE DOCUMENT ERROR]", error.message);
    res.status(500).json({ error: "Failed to delete document: " + error.message });
  }
});

module.exports = router;
