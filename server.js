// server.js
import express from "express";
import pool from "./database.js";
import dotenv from "dotenv";
import fs from "fs";
import cors from "cors";
import Twilio from "twilio";

dotenv.config();
console.log("TW vars loaded:", {
  TW_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
  TW_API_KEY_SID: !!process.env.TWILIO_API_KEY_SID,
  TW_API_KEY_SECRET: !!process.env.TWILIO_API_KEY_SECRET,
});

const app = express();
app.use(express.json());

// 👉 serve static files from the "public" directory
// Place twilio.html inside a folder called "public" in your project root
app.use(express.static("public"));

// CORS: allow the frontend origin and allow credentials (cookies) if needed
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

// load translations.json in a robust way
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
    res.status(500).json({ message: "DB connection failed", error: err.message });
  }
});

// --- Simple availability endpoint using dummy_data.json ---
app.get("/api/check_availability/:product_code", (req, res) => {
  const code = req.params.product_code;
  const product = DUMMY_DB[code];
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  return res.json({
    product_code: code,
    name: product.name,
    available: !!product.in_stock,
    quantity: typeof product.quantity === "number" ? product.quantity : null,
  });
});

// Optional: reload dummy JSON at runtime (POST)
app.post("/api/reload_dummy", (req, res) => {
  try {
    loadDummy();
    return res.json({ ok: true, count: Object.keys(DUMMY_DB).length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Twilio token endpoint ---
app.get("/api/twilio/token", (req, res) => {
  const identity = req.query.identity?.toString().trim();
  const room = req.query.room?.toString().trim();

  if (!identity) {
    return res.status(400).json({ ok: false, error: "identity is required" });
  }
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_API_KEY_SID ||
    !process.env.TWILIO_API_KEY_SECRET
  ) {
    return res.status(500).json({ ok: false, error: "Twilio credentials missing" });
  }

  try {
    const AccessToken = Twilio.jwt.AccessToken;
    const VideoGrant = AccessToken.VideoGrant;

    // Create token with identity
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      {
        ttl: parseInt(process.env.TWILIO_API_KEY_TTL || "3600", 10),
        identity,
      }
    );
    // --- Debug endpoint: returns raw JWT + decoded payload ---
/*app.get("/api/twilio/debug-token", (req, res) => {
  const identity = req.query.identity?.toString().trim();
  const room = req.query.room?.toString().trim();

  if (!identity) {
    return res.status(400).json({ ok: false, error: "identity required" });
  }

  try {
    const AccessToken = Twilio.jwt.AccessToken;
    const VideoGrant = AccessToken.VideoGrant;

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { ttl: parseInt(process.env.TWILIO_API_KEY_TTL || "3600", 10), identity }
    );

    token.addGrant(new VideoGrant({ room: room || undefined }));
    const jwt = token.toJwt();

    // Decode payload safely
    const parts = jwt.split(".");
    const payloadRaw = parts[1] || "";
    const padding = payloadRaw.length % 4 === 0 ? "" : "=".repeat(4 - (payloadRaw.length % 4));
    const payloadJson = Buffer.from(
      payloadRaw.replace(/-/g, "+").replace(/_/g, "/") + padding,
      "base64"
    ).toString("utf8");
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (e) {
      payload = { decode_error: e.message, raw: payloadJson };
    }

    // ✅ THIS return is *inside* the handler
    return res.json({ ok: true, identity, room, jwt, payload });
  } catch (err) {
    console.error("debug-token error:", err && err.stack || err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});*/


    // Add a VideoGrant (optionally restricted to a room)
    const grant = new VideoGrant({ room: room || undefined });
    token.addGrant(grant);

    // Send the JWT back
    return res.json({
      ok: true,
      token: token.toJwt(),
      ttl: parseInt(process.env.TWILIO_API_KEY_TTL || "3600", 10),
      identity,
      room,
    });
  } catch (err) {
    console.error("Failed to create Twilio token:", err);
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
      return res.status(500).json({ ok: false, error: json.error || "wrapper error" });
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
