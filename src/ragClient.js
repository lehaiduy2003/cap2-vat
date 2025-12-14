/**
 * RAG Service Client
 * HTTP client for calling the RAG microservice from model-vat service
 */

const axios = require("axios");

const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || "http://localhost:3001";
const RAG_API_KEY = process.env.RAG_API_KEY;

/**
 * Create axios instance with default config
 */
const ragClient = axios.create({
  baseURL: RAG_SERVICE_URL,
  timeout: 60000, // 60 seconds for embedding operations
  headers: {
    "x-api-key": RAG_API_KEY || "",
  },
});

/**
 * Health check
 */
async function checkRAGHealth() {
  try {
    const response = await ragClient.get("/health");
    return response.data;
  } catch (error) {
    console.error("[RAG Client] Health check failed:", error.message);
    return null;
  }
}

/**
 * Get list of documents
 */
async function getDocuments(filters = {}) {
  try {
    const response = await ragClient.get("/api/documents", { params: filters });
    return response.data.documents || response.data;
  } catch (error) {
    console.error("[RAG Client] Get documents failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get document by ID
 */
async function getDocument(documentId) {
  try {
    const response = await ragClient.get(`/api/documents/${documentId}`);
    return response.data;
  } catch (error) {
    console.error("[RAG Client] Get document failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Delete a document
 */
async function deleteDocument(documentId) {
  try {
    const response = await ragClient.delete(`/api/documents/${documentId}`);
    return response.data;
  } catch (error) {
    console.error("[RAG Client] Delete document failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Search knowledge base
 */
async function search(query, options = {}) {
  try {
    const response = await ragClient.post("/api/search", {
      query,
      top_k: options.topK || 5,
      filters: options.filters || {},
    });
    return response.data.results;
  } catch (error) {
    console.error("[RAG Client] Search failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Simple query without session
 */
async function query(question, options = {}) {
  try {
    const response = await ragClient.post("/api/retrieve", {
      query: question,
      top_k: options.topK || 5,
      temperature: options.temperature || 0.7,
    });
    return response.data;
  } catch (error) {
    console.error("[RAG Client] Query failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Process document from URL (async - fire and forget)
 * @param {number} documentId - ID of the document in VAT service
 * @param {string} uploadUrl - URL to fetch the document from
 * @param {object} metadata - Document metadata
 */
async function processDocumentFromUrl(documentId, uploadUrl, metadata = {}) {
  try {
    const VAT_SERVICE_URL = process.env.VAT_SERVICE_URL || "http://localhost:3000";
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

    const response = await ragClient.post("/api/documents/process-url", {
      document_id: documentId,
      upload_url: uploadUrl,
      vat_service_url: VAT_SERVICE_URL,
      vat_api_key: ADMIN_API_KEY,
      metadata: {
        title: metadata.title,
        original_filename: metadata.original_filename,
        owner_id: metadata.owner_id,
        property_id: metadata.property_id,
        kb_scope: metadata.property_id ? "property" : "owner",
        // Include property details for document enrichment
        description: metadata.description,
        price: metadata.price,
        room_size: metadata.room_size,
        address_details: metadata.address_details,
      },
    });

    console.log(
      `[RAG Client] Document ${documentId} processing started:`,
      response.data.message || "Success"
    );
    return response.data;
  } catch (error) {
    console.error(
      `[RAG Client] Process document from URL failed (Doc ID: ${documentId}):`,
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Test RAG service connection
 */
async function testRAGConnection() {
  try {
    const health = await checkRAGHealth();
    if(!health)
      return false;
    return true;
  } catch (error) {
    console.error("[RAG] ✗ RAG service connection failed:", error.message);
    return false;
  }
}

module.exports = {
  testRAGConnection,
  getDocuments,
  getDocument,
  deleteDocument,
  search,
  query,
  processDocumentFromUrl,
};
