// server/apiServer.js
const path = require("path");

const { testDatabaseConnection } = require("./config/db");
const {
  createDocumentProcessingWorker,
  createDocumentDeletionWorker,
} = require("./consumer/documentConsumer");
const { testRedisConnection } = require("./config/redis");
const { testRAGConnection } = require("./ragClient");
const { runJob } = require("./runSafetyScoreJob");
const { generateAISummary } = require("./aiUtils");
const floodRoutes = require("./routes/floods");
const { pool } = require("./config/db");

// --- Cấu hình ---

require("dotenv").config({ path: path.join(__dirname, "../.env") });
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const documentRoutes = require("./routes/documents");
const reviewRoutes = require("./routes/reviews");
const adminRoutes = require("./routes/admin");
const propertyRoutes = require("./routes/properties");

const app = express();
const PORT = process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());
const publicPath = path.join(__dirname, "../public");
app.use(express.static(publicPath));

// Mount routes
app.use("/api/v1", documentRoutes);
app.use("/api/v1", reviewRoutes);
app.use("/api/v1", adminRoutes);
app.use("/api/v1", propertyRoutes);
app.use("/api/v1", floodRoutes);

// --- CRON JOB ---
cron.schedule(
  "0 0,12 * * *",
  () => {
    runJob(null).catch((err) => console.error("[CRON] Thất bại:", err));
  },
  { timezone: "Asia/Ho_Chi_Minh" }
);

// Endpoint "Health Check"
app.get("/health", (req, res) => {
  res.status(200).json({ status: "API Server is running healthy." });
});
// app.get("/admin", (req, res) => {
//   res.sendFile(path.join(publicPath, "admin.html"));
// });
// app.get("/review", (req, res) => {
//   res.sendFile(path.join(publicPath, "review.html"));
// });

// Test connections
(async () => {
  console.log("[STARTUP] Testing connections...");

  const dbOk = await testDatabaseConnection();
  const ragOk = await testRAGConnection();
  const redisOk = await testRedisConnection();

  const allOk = dbOk && ragOk && redisOk;
  if (redisOk) {
    createDocumentProcessingWorker();
    createDocumentDeletionWorker();
  }
  if (allOk) {
    console.log("[STARTUP] ✓ All connections successful");
  } else {
    console.error("[STARTUP] ✗ Some connections failed:");
    if (!ragOk) console.error("  - RAG service connection failed (document processing disabled)");
    if (!redisOk) console.error("  - Redis connection failed (Worker not started)");
    if (!dbOk) {
      console.error("  - Database connection failed");
      console.error("[STARTUP] ✗ Critical: Database connection failed. Shutting down service.");
      process.exit(1);
    }
  }
})();
// --- API SAFETY WIDGET (ĐÃ FIX) ---
app.get("/api/v1/properties/:id/safety", async (req, res) => {
  const propertyId = parseInt(req.params.id, 10);
  const includeAi = req.query.include_ai === 'true';

  try {
    // 1. Lấy thông tin phòng
    const propRes = await pool.query("SELECT * FROM properties WHERE id = $1", [propertyId]);
    if (propRes.rowCount === 0) return res.status(404).json({ error: "Not found" });
    const propertyData = propRes.rows[0];

    // 2. Lấy điểm số
    let scores = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [propertyId]);
    if (scores.rowCount === 0) {
        console.log(`[Safety] Tính điểm lần đầu cho ID ${propertyId}`);
        await runJob(propertyId);
        scores = await pool.query("SELECT * FROM property_safety_scores WHERE property_id = $1", [propertyId]);
    }
    
    // Fallback nếu tính toán lỗi
    const safetyData = scores.rows[0] || { crime_score: 0, user_score: 0, env_score: 0, ai_summary: null };

    // 3. Logic AI On-demand
    let aiSummary = safetyData.ai_summary;
    if (includeAi && !aiSummary) {
        console.log(`[Safety] Generating AI for ID ${propertyId}...`);
        const reviews = await pool.query("SELECT * FROM reviews WHERE property_id=$1 LIMIT 10", [propertyId]);
        
        try {
             // [FIX] Truyền data an toàn
             aiSummary = await generateAISummary(
                safetyData.crime_score, // Hàm bên kia sẽ tự ép kiểu Number()
                safetyData.user_score, 
                safetyData.env_score,
                propertyData, 
                [], 
                reviews.rows
             );
             
             await pool.query("UPDATE property_safety_scores SET ai_summary=$1 WHERE property_id=$2", [aiSummary, propertyId]);
        } catch(e) { 
            console.error("AI Generation Error:", e.message);
            aiSummary = "Hiện tại chưa thể tạo phân tích AI."; 
        }
    }

    res.json({ ...safetyData, ai_summary: aiSummary });

  } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server Error" });
  }
});

// Khởi động Server
app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
});
