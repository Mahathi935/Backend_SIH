import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import path from "path";
import fs from "fs";
import multer from "multer";
import cron from "node-cron";
import axios from "axios";
import pool from "./database.js";  

dotenv.config();

const app = express();

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
}

app.use(cors());
app.use(express.json());

const JWT_SECRET = "your_secret_key";


// ================== Auth ==================
app.post("/signup", async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role){
    return res.status(400).json({message:"username, password, role are required"});
  }

  try{
    const [found] = await pool.query("select id from users where username = ?",[username]);
    if(found.length>0) return res.status(400).json({message: "User already exists"});

    const hashed  = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "insert into users(username,password,role) values(?, ?, ?)",
      [username, hashed, role]
    );

    const userId = result.insertId;

  

    if (role === "patient") {
      await pool.query("Insert into patients (user_id, name, age) values(?, ?, ?)",[userId, username, 0]);
    } else if (role === "doctor"){
      await pool.query("Insert into doctors (user_id, name, specialization) values (?, ?, ?)", [userId, username, "General"]);
    }

    res.status(201).json({message: "User registered"});
  } catch (err){
    console.error("SIGNUP ERR:", err);
    res.status(500).json({message: "Error creating user"});
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
    const user = rows[0];
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
    res.json({ token });
  } catch (err) {
    console.error("LOGIN ERR:", err);
    res.status(500).json({ message: "Login error" });
  }
});

// ================== Middleware ==================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid token" });

    req.user = user;
    next();
  });
}

function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied: insufficient role" });
    }
    next();
  };
}
app.get("/profile", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, username, role FROM users WHERE id = ?", [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Error fetching profile" });
  }
});


// ================== Patients ==================
// All patients (doctor/admin)
app.get("/patients", authenticateToken, authorizeRoles("doctor", "admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.user_id, p.name, p.age, u.username
      FROM patients p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.id DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch patients" });
  }
});

// My patient profile
app.get("/patients/me", authenticateToken, authorizeRoles("patient"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.user_id, p.name, p.age, u.username
      FROM patients p
      JOIN users u ON u.id = p.user_id
      WHERE u.id = ?
    `, [req.user.id]);
    res.json(rows[0] || { message: "No profile found" });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});


// ================== Doctors ==================
// All doctors (admin)
app.get("/doctors", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT d.id, d.user_id, d.name, d.specialization, u.username
      FROM doctors d
      JOIN users u ON u.id = d.user_id
      ORDER BY d.id DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch doctors" });
  }
});

// My doctor profile
app.get("/doctors/me", authenticateToken, authorizeRoles("doctor"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT d.id, d.user_id, d.name, d.specialization, u.username
      FROM doctors d
      JOIN users u ON u.id = d.user_id
      WHERE u.id = ?
    `, [req.user.id]);
    res.json(rows[0] || { message: "No profile found" });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});


// ================== Appointments ==================
// Create appointment (patient)
app.post("/appointments", authenticateToken, authorizeRoles("patient"), async (req, res) => {
  const { doctorUsername, date } = req.body; // date = "2025-09-04 18:00:00"
  if (!doctorUsername || !date) return res.status(400).json({ message: "doctorUsername and date are required" });

  try {
    const [[doctor]] = await pool.query("SELECT id FROM users WHERE username = ? AND role='doctor'", [doctorUsername]);
    if (!doctor) return res.status(400).json({ message: "Doctor not found" });

    const patientId = req.user.id;
    const doctorId = doctor.id;

    const [r] = await pool.query(
      "INSERT INTO appointments (patient_user_id, doctor_user_id, scheduled_at) VALUES (?, ?, ?)",
      [patientId, doctorId, date]
    );

    // Add a reminder 1 hour before the appointment
    await pool.query(
      "INSERT INTO reminders (user_id, message, due_at) VALUES (?, ?, DATE_SUB(?, INTERVAL 1 HOUR))",
      [patientId, `Reminder: Appointment on ${date}`, date]
    );

    res.status(201).json({ id: r.insertId, patient_user_id: patientId, doctor_user_id: doctorId, scheduled_at: date });
  } catch (err) {
    console.error("APPT CREATE ERR:", err);
    res.status(500).json({ message: "Failed to create appointment" });
  }
});

// Doctor: my appointments
app.get("/appointments", authenticateToken, authorizeRoles("doctor"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.*, pu.username AS patient_username, du.username AS doctor_username
      FROM appointments a
      JOIN users pu ON pu.id = a.patient_user_id
      JOIN users du ON du.id = a.doctor_user_id
      WHERE a.doctor_user_id = ?
      ORDER BY a.scheduled_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch appointments" });
  }
});

// Patient: my appointments
app.get("/appointments/me", authenticateToken, authorizeRoles("patient"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.*, pu.username AS patient_username, du.username AS doctor_username
      FROM appointments a
      JOIN users pu ON pu.id = a.patient_user_id
      JOIN users du ON du.id = a.doctor_user_id
      WHERE a.patient_user_id = ?
      ORDER BY a.scheduled_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch appointments" });
  }
});


// ================== Prescriptions ==================
// Create prescription (doctor)
app.post("/prescriptions", authenticateToken, authorizeRoles("doctor"), async (req, res) => {
  const { patientUsername, medicine } = req.body;
  if (!patientUsername || !medicine) return res.status(400).json({ message: "patientUsername and medicine are required" });

  try {
    const [[patient]] = await pool.query("SELECT id FROM users WHERE username = ? AND role='patient'", [patientUsername]);
    if (!patient) return res.status(400).json({ message: "Patient not found" });

    const [r] = await pool.query(
      "INSERT INTO prescriptions (patient_user_id, doctor_user_id, medicine) VALUES (?, ?, ?)",
      [patient.id, req.user.id, medicine]
    );
    res.status(201).json({ id: r.insertId, patient_user_id: patient.id, doctor_user_id: req.user.id, medicine });
  } catch (err) {
    res.status(500).json({ message: "Failed to create prescription" });
  }
});

app.get("/prescriptions/me", authenticateToken, authorizeRoles("patient"), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, du.username AS doctor_username
      FROM prescriptions p
      JOIN users du ON du.id = p.doctor_user_id
      WHERE p.patient_user_id = ?
      ORDER BY p.id DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch prescriptions" });
  }
});


// ================== File Uploads ==================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.post(
  "/prescriptions/upload",
  authenticateToken,
  authorizeRoles("doctor"),
  upload.single("file"),
  (req, res) => {
    const fileUrl = `http://localhost:3000/uploads/${req.file.filename}`;
    res.json({ message: "File uploaded successfully", fileUrl });
  }
);

// ================== Consultation Logs ==================
app.post("/consultation/start", authenticateToken, authorizeRoles("doctor", "patient"), async (req, res) => {
  const doctorId = req.user.role === "doctor" ? req.user.id : null;
  const patientId = req.user.role === "patient" ? req.user.id : null;

  try {
    const [r] = await pool.query(
      "INSERT INTO consultations (doctor_user_id, patient_user_id, status, start_time) VALUES (?, ?, 'ongoing', NOW())",
      [doctorId, patientId]
    );
    res.json({ message: "Consultation started", sessionId: r.insertId });
  } catch (err) {
    res.status(500).json({ message: "Failed to start consultation" });
  }
});

app.post("/consultation/end/:id", authenticateToken, authorizeRoles("doctor", "patient"), async (req, res) => {
  try {
    const [r] = await pool.query("UPDATE consultations SET status='ended', end_time=NOW() WHERE id = ?", [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ message: "Session not found" });

    const [[session]] = await pool.query("SELECT * FROM consultations WHERE id = ?", [req.params.id]);
    res.json({ message: "Consultation ended", session });
  } catch (err) {
    res.status(500).json({ message: "Failed to end consultation" });
  }
});


// ================== Reminders ==================
cron.schedule("* * * * *", async () => {
  try {
    const [due] = await pool.query(
      "SELECT id, user_id, message FROM reminder WHERE sent = 0 AND due_at <= NOW()"
    );
    for (const r of due) {
      console.log("Reminder:", r.message);
      await pool.query("UPDATE reminder SET sent = 1 WHERE id = ?", [r.id]);
    }
  } catch (err) {
    console.error("CRON ERR:", err.message);
  }
});

// My reminders
app.get("/reminders", authenticateToken, authorizeRoles("patient", "doctor"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, message, due_at, sent FROM reminder WHERE user_id = ? ORDER BY due_at DESC",
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch reminders" });
  }
});


// ================== Integrations ==================
// AI Symptom Checker (dummy)
app.post("/symptoms", authenticateToken, (req, res) => {
  const { symptoms } = req.body;
  res.json({ symptoms, possibleConditions: ["Fever", "Common Cold"] });
});

// Pharmacy API 
app.get("/pharmacy/medicines", authenticateToken, async (req, res) => {
  try {
    // simulate external API
    res.json([{ id: 1, name: "Paracetamol", stock: 100 }, { id: 2, name: "Amoxicillin", stock: 50 }]);
  } catch {
    res.status(500).json({ message: "Pharmacy service unavailable" });
  }
});

// SMS/Email (dummy)
app.post("/otp/send", authenticateToken, (req, res) => {
  const { phone } = req.body;
  console.log(`📩 OTP sent to ${phone}`);
  res.json({ message: `OTP sent to ${phone}` });
});

// ================== Admin Dashboard ==================
app.get("/admin/dashboard", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const [[u]]  = await pool.query("SELECT COUNT(*) AS c FROM users");
    const [[p]]  = await pool.query("SELECT COUNT(*) AS c FROM patients");
    const [[d]]  = await pool.query("SELECT COUNT(*) AS c FROM doctors");
    const [[a]]  = await pool.query("SELECT COUNT(*) AS c FROM appointments");
    const [[rx]] = await pool.query("SELECT COUNT(*) AS c FROM prescriptions");
    const [[cns]]= await pool.query("SELECT COUNT(*) AS c FROM consultations");

    res.json({
      message: `Welcome Admin ${req.user.username}`,
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
    res.status(500).json({ message: "Failed to fetch dashboard" });
  }
});


// ================== Root ==================
app.get("/", (req, res) => res.send("Telemedicine Backend Prototype Running"));

// ================== Start Server ==================
app.listen(3000, () => console.log("Server running at http://localhost:3000"));
