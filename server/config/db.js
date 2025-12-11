// server/config/db.js
const { Pool } = require("pg");
require("dotenv").config();

const dbConfig = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT, 10),
  max: 20, // Tối đa 20 kết nối
  idleTimeoutMillis: 30000,
};

const pool = new Pool(dbConfig);

pool.on("error", (err) => {
  console.error("[DB POOL ERROR]", err.message);
});

module.exports = { pool };