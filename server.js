import express from "express";
import pool from "./database.js";
import dotenv from "dotenv";
import translations from "./translations.json" assert { type: "json" };

dotenv.config();

const app = express();
app.use(express.json());

// Middleware to detect language
function detectLang(req, res, next) {
  req.lang = req.headers["accept-language"]?.split(",")[0] || "en";
  next();
}
app.use(detectLang);

// Simple translation helper
function t(lang, key) {
  const l = ["en", "hi", "pa"].includes(lang) ? lang : "en";
  return translations[l][key] || translations["en"][key] || key;
}

// Routes
app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/testdb", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({ message: "DB Connected!", result: rows[0].result });
  } catch (err) {
    res
      .status(500)
      .json({ message: "DB connection failed", error: err.message });
  }
});

// Use Render's PORT (fallback to 3000 locally)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

