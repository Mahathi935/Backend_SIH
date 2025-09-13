import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config(); 

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port:process.env.DB_PORT?Number(process.env.DB_PORT):3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4_general_ci"
});


export default pool;
