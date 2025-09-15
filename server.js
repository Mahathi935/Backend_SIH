import express from "express";
import pool from "./database.js";
import dotenv from "dotenv";
import fs from "fs";
import cors from "cors";
import Twilio from "twilio";

import { initPool, getPool } from "./db.mjs";

dotenv.config();

const app = express();
app.use(express.json());

// Initialize DB connection but don’t crash if unavailable
initPool().catch((err) => {
  console.warn("initPool() error:", err?.message || err);
});

// Middleware to inject DB pool
app.use((req, res, next) => {
  req.db = getPool(); // may be null
  next();
});

// CORS: allow frontend
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

// --- Load translations ---
let translations = {};
try {
  const jsonPath = new URL("./translations.json", import.meta.url);
  const raw = fs.readFileSync(jsonPath, "utf8");
  translations = JSON.parse(raw);
} catch (err) {
  console.error("Failed to load translations.json:", err);
  translations = { en: {} };
}

// --- Load dummy data ---
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
loadDummy();

// --- Helpers ---
function detectLang(req, res, next) {
  req.lang = req.headers["accept-language"]?.split(",")[0] || "en";
  next();
}
app.use(detectLang);

function t(lang, key) {
  const l = ["en", "hi", "pa"].includes(lang) ? lang : "en";
  return (
    (translations[l] && translations[l][key]) ||
    (translations["en"] && translations["en"][key]) ||
    key
  );
}

// --- Routes ---
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

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      {
        ttl: parseInt(process.env.TWILIO_API_KEY_TTL || "3600", 10),
        identity,
      }
    );

    const grant = new VideoGrant({ room: room || undefined });
    token.addGrant(grant);

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

// --- Proxy to Python wrapper ---
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
      result: json.result,
    });
  } catch (err) {
    console.error("Error proxying to Python wrapper:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- DEV-MOCK OTP ROUTES ----
const __DEV_OTPS = new Map(); // phone -> otp

app.post("/auth/request-otp", express.json(), (req, res) => {
  const phone = (req.body?.phone || "").toString().trim();
  if (!phone) {
    return res.status(400).json({ ok: false, error: "phone is required" });
  }
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  __DEV_OTPS.set(phone, otp);
  console.log(`[DEV-OTP] OTP for ${phone} = ${otp}`);
  return res.json({ ok: true, message: "OTP generated (dev)", phone });
});

app.post("/auth/verify-otp", express.json(), (req, res) => {
  const phone = (req.body?.phone || "").toString().trim();
  const otp = (req.body?.otp || "").toString().trim();
  if (!phone || !otp) {
    return res.status(400).json({ ok: false, error: "phone and otp required" });
  }
  const expected = __DEV_OTPS.get(phone);
  if (!expected || expected !== otp) {
    return res.status(401).json({ ok: false, error: "invalid otp" });
  }
  __DEV_OTPS.delete(phone);
  const demoToken = "demo-token-" + phone;
  return res.json({ ok: true, token: demoToken, role: "patient" });
});
// ---- END DEV-MOCK OTP ----

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
