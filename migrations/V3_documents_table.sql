-- Migration V3: Documents table for RAG document processing
-- These tables store document metadata for the VAT service
-- The RAG service will process the documents asynchronously

CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    original_filename VARCHAR(500),
    upload_url VARCHAR(1000) NOT NULL, -- URL to fetch the document from
    owner_id VARCHAR(100) NOT NULL, -- Reference to owner in VAT service
    property_id INTEGER,   -- Optional: Reference to property in VAT service
    metadata JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed
    processing_started_at TIMESTAMP WITH TIME ZONE,
    processing_completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    chunk_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create index on owner_id for faster queries
CREATE INDEX IF NOT EXISTS idx_documents_owner_id ON documents(owner_id);

-- Create index on property_id for faster queries
CREATE INDEX IF NOT EXISTS idx_documents_property_id ON documents(property_id) WHERE property_id IS NOT NULL;

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
CREATE TRIGGER trigger_update_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_documents_updated_at();