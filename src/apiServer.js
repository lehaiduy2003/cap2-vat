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
const floodRoutes = require("./routes/floods");

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

// Khởi động Server
app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
});
