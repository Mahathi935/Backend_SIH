// server.js
import express from "express";
import pool from "./database.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());

// CORS: allow the frontend origin and allow credentials (cookies) if needed
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

// load translations.json in a robust way (works regardless of Node JSON import support)
let translations = {};
try {
  const jsonPath = new URL("./translations.json", import.meta.url);
  const raw = fs.readFileSync(jsonPath, "utf8");
  translations = JSON.parse(raw);
} catch (err) {
  console.error("Failed to load translations.json:", err);
  translations = { en: {} };
}

// --- Dummy DB loader (for medicine availability) ---
const DUMMY_DATA_PATH = new URL("./dummy_data.json", import.meta.url);
let DUMMY_DB = {};
function loadDummy() {
  try {
    const raw = fs.readFileSync(DUMMY_DATA_PATH, "utf8");
    DUMMY_DB = JSON.parse(raw);
    console.log("Loaded dummy_data.json with", Object.keys(DUMMY_DB).length, "items");
  } catch (err) {
    console.error("Failed to load dummy_data.json:", err);
    DUMMY_DB = {};
  }
}
// initial load
loadDummy();

// Middleware to detect language
function detectLang(req, res, next) {
  req.lang = req.headers["accept-language"]?.split(",")[0] || "en";
  next();
}
app.use(detectLang);

// Simple translation helper
function t(lang, key) {
  const l = ["en", "hi", "pa"].includes(lang) ? lang : "en";
  return (
    (translations[l] && translations[l][key]) ||
    (translations["en"] && translations["en"][key]) ||
    key
  );
}

// Routes
app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/api/hello", (req, res) => {
  res.json({ message: "hello from backend", time: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
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

// --- NEW: Simple availability endpoint using dummy_data.json ---
// GET /api/check_availability/:product_code
// Returns normalized JSON: { product_code, name, available, quantity }
app.get('/api/check_availability/:product_code', (req, res) => {
  const code = req.params.product_code;
  const product = DUMMY_DB[code];
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  return res.json({
    product_code: code,
    name: product.name,
    available: !!product.in_stock,
    quantity: typeof product.quantity === 'number' ? product.quantity : null
  });
});

// Optional: reload dummy JSON at runtime (POST)
app.post('/api/reload_dummy', (req, res) => {
  try {
    loadDummy();
    return res.json({ ok: true, count: Object.keys(DUMMY_DB).length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// NEW: route that proxies to Python wrapper
app.post("/api/v1/message", async (req, res) => {
  const body = req.body || {};
  const messages = body.messages ?? body.text ?? body.message ?? "";

  try {
    const r = await fetch("http://127.0.0.1:5001/internal/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });

    const json = await r.json();
    if (!json.ok) {
      return res
        .status(500)
        .json({ ok: false, error: json.error || "wrapper error" });
    }

    return res.json({
      ok: true,
      conversationId: body.conversationId ?? null,
      result: json.result, // { reply, tag, precaution }
    });
  } catch (err) {
    console.error("Error proxying to Python wrapper:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Start server on Render provided PORT or local fallback
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
