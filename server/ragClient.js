/**
 * RAG Service Client
 * HTTP client for calling the RAG microservice from model-vat service
 */

const axios = require("axios");
const FormData = require("form-data");

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
 * Upload a document
 * @param {FormData|Buffer} fileData - FormData object or file buffer
 * @param {string} filename - Optional filename (required if fileData is Buffer)
 * @param {object} metadata - Optional metadata
 */
async function uploadDocument(fileData, filename = null, metadata = {}) {
  try {
    let formData;

    // If fileData is already FormData, use it directly
    if (fileData instanceof FormData) {
      formData = fileData;
    } else {
      // Otherwise, create new FormData
      formData = new FormData();
      formData.append("file", fileData, filename);
      formData.append("title", metadata.title || filename);
      formData.append("uploaded_by", metadata.uploaded_by || "system");
      if (metadata.owner_id) formData.append("owner_id", metadata.owner_id);
      if (metadata.property_id) formData.append("property_id", metadata.property_id);
      if (metadata.kb_scope) formData.append("kb_scope", metadata.kb_scope);
      if (metadata.chunk_size) formData.append("chunk_size", metadata.chunk_size);
      if (metadata.overlap) formData.append("overlap", metadata.overlap);
      if (metadata.metadata) formData.append("metadata", JSON.stringify(metadata.metadata));
    }

    const response = await ragClient.post("/api/rag/documents/upload", formData, {
      headers: formData.getHeaders ? formData.getHeaders() : {},
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return response.data;
  } catch (error) {
    console.error("[RAG Client] Upload failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get list of documents
 */
async function getDocuments(filters = {}) {
  try {
    const response = await ragClient.get("/api/rag/documents", { params: filters });
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
    const response = await ragClient.get(`/api/rag/documents/${documentId}`);
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
    const response = await ragClient.delete(`/api/rag/documents/${documentId}`);
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
 * Create a new chat session
 */
async function createChatSession(userId = null, metadata = {}) {
  try {
    const response = await ragClient.post("/api/chat/sessions", {
      user_id: userId,
      metadata,
    });
    return response.data.session_id;
  } catch (error) {
    console.error("[RAG Client] Create session failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get chat history
 */
async function getChatHistory(sessionId, limit = 50) {
  try {
    const response = await ragClient.get(`/api/chat/sessions/${sessionId}`, {
      params: { limit },
    });
    return response.data.messages;
  } catch (error) {
    console.error("[RAG Client] Get history failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Send a chat message
 */
async function chat(message, options = {}) {
  try {
    const response = await ragClient.post("/api/chat", {
      session_id: options.sessionId,
      message,
      top_k: options.topK || 5,
      include_history: options.includeHistory !== false,
      temperature: options.temperature || 0.7,
    });
    return response.data;
  } catch (error) {
    console.error("[RAG Client] Chat failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Simple query without session
 */
async function query(question, options = {}) {
  try {
    const response = await ragClient.post("/api/query", {
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
 * Delete a chat session
 */
async function deleteChatSession(sessionId) {
  try {
    const response = await ragClient.delete(`/api/chat/sessions/${sessionId}`);
    return response.data;
  } catch (error) {
    console.error("[RAG Client] Delete session failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get user sessions
 */
async function getUserSessions(userId, limit = 20) {
  try {
    const response = await ragClient.get(`/api/users/${userId}/sessions`, {
      params: { limit },
    });
    return response.data.sessions;
  } catch (error) {
    console.error("[RAG Client] Get user sessions failed:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Process a stored document (tell RAG to fetch and process it)
 */
async function processStoredDocument(documentId, options = {}) {
  try {
    const response = await ragClient.post("/api/rag/documents/process", {
      document_id: documentId,
      model_vat_url: options.model_vat_url,
      chunk_size: options.chunk_size || 500,
      overlap: options.overlap || 50,
    });
    return response.data;
  } catch (error) {
    console.error("[RAG Client] Process document failed:", error.response?.data || error.message);
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
 * Async wrapper for processDocumentFromUrl (fire and forget)
 */
function processDocumentAsync(documentId, uploadUrl, metadata = {}) {
  // Start processing but don't wait for it to complete
  processDocumentFromUrl(documentId, uploadUrl, metadata).catch((err) => {
    console.error(`[RAG Client] Async processing failed for document ${documentId}:`, err.message);
  });

  console.log(`[RAG Client] Triggered async processing for document ${documentId}`);
}

module.exports = {
  checkRAGHealth,
  uploadDocument,
  getDocuments,
  getDocument,
  deleteDocument,
  search,
  createChatSession,
  getChatHistory,
  chat,
  query,
  deleteChatSession,
  getUserSessions,
  processStoredDocument,
  processDocumentFromUrl,
  processDocumentAsync,
};
