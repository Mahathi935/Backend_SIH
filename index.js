import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import multer from "multer";
import cron from "node-cron";
import axios from "axios";
import pool from "./database.js";
import translations from "./translations.json" assert {type:"json"};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key";
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

//----------------Translation Middleware---------
function detectLang(req, res, next){
  req.lang = req.headers["accept-language"]?.split(",")[0] || "en";
  next();
}
app.use(detectLang);

function t(lang,key){
  const l = ["en","hi","pa"].includes(lang) ? lang:"en";
  return translations[l][key] || translations["en"][key] || key;
}

// ----------------- DB helpers -----------------

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function exec(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

// ----------------- Auth helpers / middleware -----------------
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: t(req.lang, "no_token") });

  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ message: t(req.lang, "invalid_token") });
    req.user = payload; // { id, username, role, iat, exp }
    next();
  });
}
function authorizeRoles(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ message: t(req.lang, "access_denied") });
    }
    next();
  };
}

// ================== OTP Auth ==================
const otpStore = new Map();
const OTP_TTL_SEC = 300; // 5 minutes

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// 1. Request OTP
app.post("/auth/send-otp", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(500).json({ message: t(req.lang, "phone_required") });

  // check if user exists
  const [users] = await pool.query("SELECT * FROM users WHERE username = ?", [phone]);

  if (users.length === 0) {
    return res.json({ registered: false, message: t(req.lang, "phone_not_registered") });
  }

  const otp = generateOTP();
  otpStore.set(phone, { otp, expiresAt: Date.now() + OTP_TTL_SEC * 1000 });

  console.log(`DEBUG OTP for ${phone}: ${otp}`); // in real app: send SMS

  res.json({ registered: true, message: t(req.lang, "otp_sent") });
});

// 2. Verify OTP
app.post("/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(500).json({ message: t(req.lang, "phone_otp_required") });

  const entry = otpStore.get(phone);
  if (!entry || Date.now() > entry.expiresAt) {
    return res.status(400).json({ message: t(req.lang, "otp_expired") });
  }
  if (entry.otp !== otp) {
    return res.status(400).json({ message: t(req.lang, "invalid_otp") });
  }

  otpStore.delete(phone);

  // fetch user
  const [[user]] = await pool.query("SELECT * FROM users WHERE username = ?", [phone]);
  if (!user) return res.status(400).json({ message: t(req.lang, "user_not_found") });

  // create JWT
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ message: t(req.lang, "login_success"), token, role: user.role });
});

// 3. Register (if phone not registered)
app.post("/register", async (req, res) => {
  const { role, phone, name, age, specialization } = req.body;

  if (!phone || !role) return res.status(400).json({ message: t(req.lang, "phone_role_required") });
  if (!["patient", "doctor"].includes(role))
    return res.status(400).json({ message: t(req.lang, "invalid_role") });

  const [exists] = await pool.query("SELECT id FROM users WHERE username=?", [phone]);
  if (exists.length > 0) return res.status(400).json({ message: t(req.lang, "already_registered") });

  const [r] = await pool.query("INSERT INTO users (username, role) VALUES (?, ?)", [phone, role]);
  const userId = r.insertId;

  if (role === "patient") {
    await pool.query(
      "INSERT INTO patients (user_id, name, age) VALUES (?, ?, ?)",
      [userId, name || phone, age || null]
    );
  } else if (role === "doctor") {
    await pool.query(
      "INSERT INTO doctors (user_id, name, specialization) VALUES (?, ?, ?)",
      [userId, name || phone, specialization || "General"]
    );
  }

  res.status(201).json({ message: t(req.lang, "registered_success") });
});

// ----------------- Profiles -----------------
app.get("/profile", authenticateToken, async (req, res) => {
  try {
    const rows = await q("SELECT id, username, role FROM users WHERE id = ?", [req.user.id]);
    return res.json(rows[0] || null);
  } catch (err) {
    console.error("PROFILE ERR:", err);
    return res.status(500).json({ message: t(req.lang, "profile_error") });
  }
});

// ----------------- Doctors & Patients endpoints -----------------
app.get("/doctors", async (req, res) => {
  try {
    const dept = req.query.department;
    let sql = "SELECT d.id, d.user_id, d.name, d.specialization, u.username AS phone FROM doctors d JOIN users u ON u.id = d.user_id";
    const params = [];
    if (dept) {
      sql += " WHERE d.specialization = ?";
      params.push(dept);
    }
    sql += " ORDER BY d.id DESC";
    const rows = await q(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error("GET DOCTORS ERR:", err);
    return res.status(500).json({ message: t(req.lang, "doctors_error") });
  }
});

app.get("/doctors/me", authenticateToken, authorizeRoles("doctor"), async (req, res) => {
  try {
    const rows = await q(
      `SELECT d.id, d.user_id, d.name, d.specialization, u.username AS phone
       FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.user_id = ?`,
      [req.user.id]
    );
    return res.json(rows[0] || null);
  } catch (err) {
    console.error("DOCTOR ME ERR:", err);
    return res.status(500).json({ message: t(req.lang, "doctors_error") });
  }
});

app.get("/patients/me", authenticateToken, authorizeRoles("patient"), async (req, res) => {
  try {
    const rows = await q("SELECT id, user_id, name, age, phone FROM patients WHERE user_id = ?", [req.user.id]);
    return res.json(rows[0] || null);
  } catch (err) {
    console.error("PATIENT ME ERR:", err);
    return res.status(500).json({ message: t(req.lang, "patients_error") });
  }
});

// ----------------- Appointments -----------------
// Patient creates appointment
app.post("/appointments", authenticateToken, authorizeRoles("patient"), async (req, res) => {
  try {
    const { doctorId, doctorUsername, scheduled_at } = req.body;
    if (!scheduled_at || (!doctorId && !doctorUsername)) {
      return res.status(400).json({ message: t(req.lang, "appointment_required") });
    }

    // resolve doctor id if username provided
    let docId = doctorId;
    if (!docId && doctorUsername) {
      const rows = await q("SELECT id FROM users WHERE username = ? AND role = 'doctor'", [doctorUsername]);
      if (rows.length === 0) return res.status(404).json({ message: t(req.lang, "doctors_error") });
      docId = rows[0].id;
    }

    // verify doctor exists
    const drCheck = await q("SELECT id FROM users WHERE id = ? AND role = 'doctor'", [docId]);
    if (drCheck.length === 0) return res.status(404).json({ message: t(req.lang, "doctors_error") });

    // conflict check
    const conflict = await q("SELECT id FROM appointments WHERE doctor_user_id = ? AND scheduled_at = ?", [docId, scheduled_at]);
    if (conflict.length > 0) return res.status(409).json({ message: "Doctor already booked at that time" });

    const result = await exec("INSERT INTO appointments (patient_user_id, doctor_user_id, scheduled_at) VALUES (?, ?, ?)", [req.user.id, docId, scheduled_at]);

    // add reminder 1 hour before
    await exec("INSERT INTO reminders (user_id, message, due_at) VALUES (?, ?, DATE_SUB(?, INTERVAL 1 HOUR))", [
      req.user.id,
      `Reminder: Appointment at ${scheduled_at}`,
      scheduled_at,
    ]);

    return res.status(201).json({ message: t(req.lang, "appointment_booked"), id: result.insertId });
  } catch (err) {
    console.error("CREATE APPT ERR:", err);
    return res.status(500).json({ message: t(req.lang, "appointment_error") });
  }
});

// View appointments (patient sees own; doctor sees own)
app.get("/appointments", authenticateToken, async (req, res) => {
  try {
    if (req.user.role === "patient") {
      const rows = await q(
        `SELECT a.*, u.username AS doctor_phone, d.name AS doctor_name
         FROM appointments a
         JOIN users u ON u.id = a.doctor_user_id
         LEFT JOIN doctors d ON d.user_id = a.doctor_user_id
         WHERE a.patient_user_id = ?
         ORDER BY a.scheduled_at DESC`,
        [req.user.id]
      );
      return res.json(rows);
    }
    if (req.user.role === "doctor") {
      const rows = await q(
        `SELECT a.*, u.username AS patient_phone, p.name AS patient_name
         FROM appointments a
         JOIN users u ON u.id = a.patient_user_id
         LEFT JOIN patients p ON p.user_id = a.patient_user_id
         WHERE a.doctor_user_id = ?
         ORDER BY a.scheduled_at DESC`,
        [req.user.id]
      );
      return res.json(rows);
    }
    return res.status(403).json({ message: "Not allowed" });
  } catch (err) {
    console.error("GET APPTS ERR:", err);
    return res.status(500).json({ message: "Failed to fetch appointments" });
  }
});

// optional: patient-specific endpoint
app.get("/appointments/me", authenticateToken, authorizeRoles("patient"), async (req, res) => {
  try {
    const rows = await q(
      `SELECT a.*, u.username AS doctor_phone, d.name AS doctor_name
       FROM appointments a
       JOIN users u ON u.id = a.doctor_user_id
       LEFT JOIN doctors d ON d.user_id = a.doctor_user_id
       WHERE a.patient_user_id = ?
       ORDER BY a.scheduled_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("GET APPTS ME ERR:", err);
    return res.status(500).json({ message: "Failed to fetch appointments" });
  }
});

// ----------------- Prescriptions -----------------
// Doctor creates prescription
app.post("/prescriptions", authenticateToken, authorizeRoles("doctor"), async (req, res) => {
  try {
    const { patientId, patientUsername, medicine } = req.body;
    if (!medicine || (!patientId && !patientUsername)) return res.status(400).json({ message: t(req.lang, "prescription_required") });

    let pid = patientId;
    if (!pid && patientUsername) {
      const p = await q("SELECT id FROM users WHERE username = ? AND role = 'patient'", [patientUsername]);
      if (p.length === 0) return res.status(404).json({ message: "Patient not found" });
      pid = p[0].id;
    }

    const r = await exec("INSERT INTO prescriptions (patient_user_id, doctor_user_id, medicine) VALUES (?, ?, ?)", [pid, req.user.id, medicine]);
    return res.status(201).json({ message: t(req.lang, "prescription_added"), id: r.insertId });
  } catch (err) {
    console.error("CREATE RX ERR:", err);
    return res.status(500).json({ message: t(req.lang, "prescription_error") });
  }
});

// View prescriptions: patient sees their prescriptions; doctor sees ones they authored
app.get("/prescriptions", authenticateToken, async (req, res) => {
  try {
    if (req.user.role === "patient") {
      const rows = await q(
        `SELECT p.*, d.name AS doctor_name
         FROM prescriptions p
         LEFT JOIN doctors d ON d.user_id = p.doctor_user_id
         WHERE p.patient_user_id = ?
         ORDER BY p.created_at DESC`,
        [req.user.id]
      );
      return res.json(rows);
    }
    if (req.user.role === "doctor") {
      const rows = await q(
        `SELECT p.*, pt.name AS patient_name
         FROM prescriptions p
         LEFT JOIN patients pt ON pt.user_id = p.patient_user_id
         WHERE p.doctor_user_id = ?
         ORDER BY p.created_at DESC`,
        [req.user.id]
      );
      return res.json(rows);
    }
    return res.status(403).json({ message: "Not allowed" });
  } catch (err) {
    console.error("GET RX ERR:", err);
    return res.status(500).json({ message: "Failed to fetch prescriptions" });
  }
});

// ----------------- Uploads (multer) -----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only images and PDFs allowed"), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

app.post("/uploads", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: t(req.lang, "file_required") });
    const url = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    await exec("INSERT INTO uploads (user_id, original_name, server_filename, url) VALUES (?, ?, ?, ?)", [req.user.id, req.file.originalname, req.file.filename, url]);
    return res.json({ message: t(req.lang, "file_uploaded"), url });
  } catch (err) {
    console.error("UPLOAD ERR:", err);
    return res.status(500).json({ message: "File upload failed", error: err.message });
  }
});
app.use("/uploads", express.static(UPLOADS_DIR));

// ----------------- Consultations -----------------
// Start consultation - doctor or patient can call; need both ids or infer caller
app.post("/consultations/start", authenticateToken, async (req, res) => {
  try {
    const { doctorUserId, patientUserId } = req.body;
    let doc = doctorUserId || null;
    let pat = patientUserId || null;

    if (req.user.role === "doctor") doc = req.user.id;
    if (req.user.role === "patient") pat = req.user.id;

    if (!doc || !pat) return res.status(400).json({ message: "doctorUserId and patientUserId required (or caller must be doctor/patient)" });

    const r = await exec("INSERT INTO consultations (doctor_user_id, patient_user_id, status, start_time) VALUES (?, ?, 'ongoing', NOW())", [doc, pat]);
    return res.json({ message: "Consultation started", id: r.insertId });
  } catch (err) {
    console.error("CONS START ERR:", err);
    return res.status(500).json({ message: "Failed to start consultation" });
  }
});

// End consultation
app.post("/consultations/end/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await exec("UPDATE consultations SET status='ended', end_time = NOW() WHERE id = ?", [id]);
    if (r.affectedRows === 0) return res.status(404).json({ message: "Consultation not found" });
    const rows = await q("SELECT * FROM consultations WHERE id = ?", [id]);
    return res.json({ message: "Consultation ended", session: rows[0] });
  } catch (err) {
    console.error("CONS END ERR:", err);
    return res.status(500).json({ message: "Failed to end consultation" });
  }
});

// List consultations for user
app.get("/consultations", authenticateToken, async (req, res) => {
  try {
    if (req.user.role === "doctor") {
      const rows = await q("SELECT * FROM consultations WHERE doctor_user_id = ? ORDER BY start_time DESC", [req.user.id]);
      return res.json(rows);
    }
    if (req.user.role === "patient") {
      const rows = await q("SELECT * FROM consultations WHERE patient_user_id = ? ORDER BY start_time DESC", [req.user.id]);
      return res.json(rows);
    }
    return res.status(403).json({ message: "Not allowed" });
  } catch (err) {
    console.error("GET CONSULTS ERR:", err);
    return res.status(500).json({ message: "Failed to fetch consultations" });
  }
});

// ----------------- Reminders -----------------
// Create reminder
app.post("/reminders", authenticateToken, async (req, res) => {
  try {
    const { message, due_at } = req.body;
    if (!message || !due_at) return res.status(400).json({ message: "message and due_at required" });
    const r = await exec("INSERT INTO reminders (user_id, message, due_at) VALUES (?, ?, ?)", [req.user.id, message, due_at]);
    return res.status(201).json({ message: "Reminder created", id: r.insertId });
  } catch (err) {
    console.error("CREATE REM ERR:", err);
    return res.status(500).json({ message: "Failed to create reminder" });
  }
});

// Get my reminders
app.get("/reminders", authenticateToken, async (req, res) => {
  try {
    const rows = await q("SELECT id, message, due_at, sent, created_at FROM reminders WHERE user_id = ? ORDER BY due_at DESC", [req.user.id]);
    return res.json(rows);
  } catch (err) {
    console.error("GET REM ERR:", err);
    return res.status(500).json({ message: "Failed to fetch reminders" });
  }
});

// Cron to process due reminders (every minute)
cron.schedule("* * * * *", async () => {
  try {
    const due = await q("SELECT id, user_id, message FROM reminders WHERE sent = 0 AND due_at <= NOW()");
    for (const r of due) {
      console.log(`Reminder -> user_id: ${r.user_id} message: ${r.message}`);
      await exec("UPDATE reminders SET sent = 1 WHERE id = ?", [r.id]);
    }
  } catch (err) {
    console.error("REMINDER CRON ERR:", err.message);
  }
});

// ----------------- Integrations -----------------
// Symptom checker (dummy)
app.post("/symptoms", authenticateToken, (req, res) => {
  const { symptoms } = req.body;
  if (!Array.isArray(symptoms) || symptoms.length === 0) return res.status(400).json({ message: "Provide an array of symptoms" });
  const possible = ["Common Cold", "Influenza", "Allergic Rhinitis"];
  return res.json({ symptoms, possibleConditions: possible.slice(0, 3), note: "Demo response, not medical advice." });
});


// OTP send demo (protected)
app.post("/otp/send", authenticateToken, (req, res) => {
  const { phone } = req.body;
  console.log(`📩 OTP sent to ${phone}`);
  return res.json({ message: `OTP sent to ${phone}` });
});

// ----------------- Admin dashboard -----------------
app.get("/admin/dashboard", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const u = (await q("SELECT COUNT(*) AS c FROM users"))[0];
    const p = (await q("SELECT COUNT(*) AS c FROM patients"))[0];
    const d = (await q("SELECT COUNT(*) AS c FROM doctors"))[0];
    const a = (await q("SELECT COUNT(*) AS c FROM appointments"))[0];
    const rx = (await q("SELECT COUNT(*) AS c FROM prescriptions"))[0];
    const cns = (await q("SELECT COUNT(*) AS c FROM consultations"))[0];

    return res.json({
      message: `Welcome Admin ${req.user.username || ""}`,
      stats: {
        totalUsers: u.c,
        totalPatients: p.c,
        totalDoctors: d.c,
        totalAppointments: a.c,
        totalPrescriptions: rx.c,
        totalConsultations: cns.c,
      },
    });
  } catch (err) {
    console.error("ADMIN DASH ERR:", err);        
    return res.status(500).json({ message: "Failed to fetch dashboard" });
  }
});

// ----------------- Root & Start -----------------
app.get("/", (req, res) => res.send("Telemedicine Backend Prototype Running"));

app.listen(PORT, () => {
  console.log(` Server running at http://localhost:${PORT}`);
});
