// backend/db_test.js
require('dotenv').config();
const mysql = require('mysql2/promise');

async function test() {
  const config = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'user',
    password: process.env.DB_PASSWORD || 'yourPassword',
    database: process.env.DB_NAME || 'healthcare_db',
    port: Number(process.env.DB_PORT || 3306),
    connectTimeout: 5000
  };

  console.log('Testing DB connection with config:', {
    host: config.host,
    user: config.user,
    database: config.database,
    port: config.port
  });

  try {
    const pool = mysql.createPool(config);
    // quick simple check
    const [rows] = await pool.query('SELECT 1 AS ok');
    console.log('Query result:', rows);
    // optionally list tables in your DB
    const [tables] = await pool.query("SHOW TABLES;");
    console.log('Tables in database (first 10):', tables.slice(0,10));
    await pool.end();
    console.log('DB connection test succeeded ✅');
    process.exit(0);
  } catch (err) {
    console.error('DB connection test failed ❌');
    console.error(err && err.message ? err.message : err);
    process.exit(2);
  }
}

test();
