require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");
const { generateAISummary } = require("./aiUtils");

// --- Cấu hình ---
const dbConfig = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT, 10),
};

const pool = new Pool(dbConfig);
pool.on("error", (err) => {
  console.error("[DB POOL - WORKER] Lỗi kết nối CSDL:", err.message);
});

/**
 * Hàm chính của Worker: Tìm và Xử lý Job
 */
async function processQueue() {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN"); // Bắt đầu Transaction

    // 1. Tìm và KHÓA (LOCK) một job 'pending'
    const findJobQuery = {
      text: `
                SELECT id, property_id, payload
                FROM ai_generation_queue
                WHERE status = 'pending'
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED; 
            `,
    };
    const jobRes = await client.query(findJobQuery);

    if (jobRes.rowCount === 0) {
      await client.query("COMMIT");
      return false; // Không có việc
    }

    const job = jobRes.rows[0];

    // 2. Đánh dấu 'processing'
    await client.query("UPDATE ai_generation_queue SET status = $1 WHERE id = $2", [
      "processing",
      job.id,
    ]);

    // 3. Gọi AI (Việc chậm)
    const { crimeScore, userScore, envScore } = job.payload;

    // Fetch property details
    const propertyResult = await client.query("SELECT * FROM properties WHERE id = $1", [
      job.property_id,
    ]);

    let propertyData = null;
    if (propertyResult.rowCount > 0) {
      propertyData = propertyResult.rows[0];
    }

    // TODO: Fetch nearby places from external API
    const nearbyPlaces = [];

    // Fetch reviews for the property
    const reviewsResult = await client.query(
      "SELECT safety_rating, cleanliness_rating, amenities_rating, host_rating, review_text FROM reviews WHERE property_id = $1 ORDER BY created_at DESC",
      [job.property_id]
    );
    const reviews = reviewsResult.rows;

    const aiSummary = await generateAISummary(
      crimeScore,
      userScore,
      envScore,
      propertyData,
      nearbyPlaces,
      reviews
    );
    if (!aiSummary) {
      // Nếu AI lỗi, đánh dấu 'failed' và rollback
      await client.query(
        "UPDATE ai_generation_queue SET status = $1, processed_at = NOW() WHERE id = $2",
        ["failed", job.id]
      );
      await client.query("COMMIT");
      console.error(`[AI WORKER] Job ${job.id} thất bại do AI trả về null.`);
      return true; // Vẫn là "đã làm việc"
    }

    // 4. Cập nhật kết quả vào bảng chính (property_safety_scores)
    await client.query("UPDATE property_safety_scores SET ai_summary = $1 WHERE property_id = $2", [
      aiSummary,
      job.property_id,
    ]);

    // 5. Đánh dấu 'done'
    await client.query(
      "UPDATE ai_generation_queue SET status = $1, processed_at = NOW() WHERE id = $2",
      ["done", job.id]
    );

    await client.query("COMMIT"); // Hoàn tất Transaction
    return true; // Báo là đã xử lý 1 việc
  } catch (err) {
    if (client) await client.query("ROLLBACK"); // Hoàn tác nếu lỗi
    console.error("[AI WORKER LỖI]", err.message);
    // (Nếu lỗi nghiêm trọng, job sẽ vẫn là 'pending' và được thử lại sau)
    return false;
  } finally {
    if (client) client.release(); // Trả kết nối về Pool
  }
}

/**
 * Vòng lặp chính của Worker (Polling)
 */
async function startWorker() {
  console.log("[AI WORKER] Bắt đầu chạy...");
  while (true) {
    try {
      const didWork = await processQueue();
      if (!didWork) {
        // Nếu không có việc gì, nghỉ 5 giây
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (e) {
      // Lỗi ở vòng lặp, đợi 10 giây
      console.error("[AI WORKER LỖI VÒNG LẶP]", e);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

startWorker();
