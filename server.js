import express from "express";
import pool from "./database.js";
import dotenv from "dotenv";
import translations from "./translations.json" assert {typo: "json"}

dotenv.config();

const app = express();
app.use(express.json());

function detectLang(req, res, next){
  req.lang = req.headers["accept-language"]?.split(",")[0] || "en";
  next();
}
app.use(detectLang);

function t(lang, key){
  const l = ["en","hi","pa"].includes(lang)?lang:"en";
  return translations[l][key] || translations["en"][key] || key;
}

app.get("/", (req, res) => {
  res.send("Server is running ");
});

app.get("/testdb", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({ message: "DB Connected!", result: rows[0].result });
  } catch (err) {
    res.status(500).json({ message: "DB connection failed", error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
