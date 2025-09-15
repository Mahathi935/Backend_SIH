// backend/db.mjs
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

let pool = null;

export async function initPool() {
  if (pool) return pool;
  const cfg = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'user',
    password: process.env.DB_PASSWORD || 'yourPassword',
    database: process.env.DB_NAME || 'healthcare_db',
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };

  try {
    pool = mysql.createPool(cfg);
    // quick check
    const conn = await pool.getConnection();
    conn.release();
    console.log('DB connected');
  } catch (err) {
    console.warn('DB connection failed — continuing in degraded mode:', err.message);
    pool = null; // mark unavailable
  }
  return pool;
}

export function getPool() {
  return pool;
}
