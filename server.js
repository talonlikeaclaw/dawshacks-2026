require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const RATE_LIMIT_SECONDS = parseInt(process.env.RATE_LIMIT_SECONDS || "10", 10);
const MAX_SMS_LENGTH = 320; // Keep responses under 320 chars when possible
const SYSTEM_PROMPT = `You are a helpful AI assistant reachable via SMS. 
Keep responses SHORT and CONCISE (under 320 characters when possible). 
Use simple language. No markdown formatting. Be friendly but brief.`;

// ─── CLIENTS ──────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────
const conversations = []; // Recent messages for status page
const rateLimitMap = new Map(); // phone -> last request timestamp
const MAX_CONVERSATIONS = 50;

// ─── HELPERS ──────────────────────────────────────────────────────────
function anonymizePhone(phone) {
  // Show only last 4 digits, e.g. +1******1234
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length <= 4) return "****" + cleaned;
  return "+" + "*".repeat(cleaned.length - 4) + cleaned.slice(-4);
}

function checkRateLimit(phone) {
  const now = Date.now();
  const last = rateLimitMap.get(phone);
  if (last && now - last < RATE_LIMIT_SECONDS * 1000) {
    const wait = Math.ceil((RATE_LIMIT_SECONDS * 1000 - (now - last)) / 1000);
    return { allowed: false, wait };
  }
  rateLimitMap.set(phone, now);
  return { allowed: true };
}

function splitSms(text) {
  // GSM-7: 160 chars per segment, but 153 for multi-part (7 chars for UDH)
  // To keep it simple for hackathon: hard split at 153 with "..." continuation
  if (text.length <= 160) return [text];
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    const cut = remaining.length > 153 ? 153 : remaining.length;
    segments.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return segments;
}

function addConversation(phone, direction, body, status) {
  const entry = {
    id: Date.now() + Math.random().toString(36).slice(2, 7),
    time: new Date().toISOString(),
    phone: anonymizePhone(phone),
    direction, // 'inbound' | 'outbound'
    body: body.slice(0, 500),
    status, // 'success' | 'error' | 'rate-limited'
  };
  conversations.unshift(entry);
  if (conversations.length > MAX_CONVERSATIONS) conversations.pop();
  return entry;
}

// ─── SMS WEBHOOK ──────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const { Body, From, MessageSid } = req.body;

  console.log(`[${new Date().toISOString()}] Webhook from ${From}: "${Body}"`);

  // Validate webhook
  if (!From || !Body) {
    console.error("Malformed webhook:", req.body);
    return res.status(400).send("<Response></Response>");
  }

  const messageBody = Body.trim();

  // Handle empty messages
  if (!messageBody) {
    console.log("Empty message from", From);
    addConversation(From, "inbound", "", "error");
    await sendSms(
      From,
      "Looks like your message was empty. Send me a question!",
    );
    return res.status(200).type("text/xml").send("<Response></Response>");
  }

  // Rate limiting
  const rateCheck = checkRateLimit(From);
  if (!rateCheck.allowed) {
    console.log(`Rate limited: ${From} (wait ${rateCheck.wait}s)`);
    addConversation(From, "inbound", messageBody, "rate-limited");
    await sendSms(
      From,
      `Whoa there! Wait ${rateCheck.wait}s before sending another message.`,
    );
    return res.status(200).type("text/xml").send("<Response></Response>");
  }

  // Log inbound
  addConversation(From, "inbound", messageBody, "success");

  try {
    // Call Gemini
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: SYSTEM_PROMPT + "\n\nUser: " + messageBody }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.7,
      },
    });

    const aiText = result.response.text().trim();
    console.log(`Gemini response for ${From}: "${aiText.slice(0, 80)}..."`);

    // Send response(s)
    const segments = splitSms(aiText);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const prefix =
        segments.length > 1 ? `(${i + 1}/${segments.length}) ` : "";
      await sendSms(From, prefix + segment);
    }

    // Log outbound
    addConversation(From, "outbound", aiText, "success");
  } catch (err) {
    console.error("Gemini API error:", err.message);
    addConversation(From, "outbound", "", "error");
    await sendSms(
      From,
      "Sorry, the AI is having trouble right now. Try again in a moment!",
    );
  }

  res.status(200).type("text/xml").send("<Response></Response>");
});

async function sendSms(to, body) {
  try {
    await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    console.log(`SMS sent to ${to}: "${body.slice(0, 60)}..."`);
  } catch (err) {
    console.error("Twilio send error:", err.message);
  }
}

// ─── STATUS PAGE ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const recent = conversations.slice(0, 20);
  const rows = recent
    .map((c) => {
      const time = new Date(c.time).toLocaleTimeString();
      const dirIcon = c.direction === "inbound" ? "📥" : "📤";
      const statusColor =
        c.status === "success"
          ? "#10b981"
          : c.status === "rate-limited"
            ? "#f59e0b"
            : "#ef4444";
      return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">${time}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${c.phone}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:14px;">${dirIcon} ${escapeHtml(c.body)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">
          <span style="background:${statusColor};color:white;padding:2px 8px;border-radius:12px;font-size:11px;text-transform:uppercase;">${c.status}</span>
        </td>
      </tr>
    `;
    })
    .join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SMS-Gemini Bridge | Live Status</title>
  <meta http-equiv="refresh" content="3">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 40px 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 28px; margin: 0 0 8px; color: #fff; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat-card { background: #1e293b; border-radius: 12px; padding: 16px 20px; flex: 1; min-width: 140px; }
    .stat-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 24px; font-weight: 700; color: #fff; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
    th { text-align: left; padding: 12px 8px; background: #334155; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #cbd5e1; }
    .pulse { display: inline-block; width: 10px; height: 10px; background: #10b981; border-radius: 50%; margin-right: 8px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .empty { text-align: center; padding: 40px; color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <h1><span class="pulse"></span>SMS-Gemini Bridge</h1>
    <p class="subtitle">Live conversation feed — refreshes every 3 seconds</p>
    
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Total Messages</div>
        <div class="stat-value">${conversations.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Rate Limit</div>
        <div class="stat-value">${RATE_LIMIT_SECONDS}s</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Status</div>
        <div class="stat-value" style="color:#10b981;font-size:18px;">ONLINE</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Phone</th>
          <th>Message</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="4" class="empty">No messages yet. Text the Twilio number to start!</td></tr>'}
      </tbody>
    </table>
  </div>
</body>
</html>`);
});

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    conversations: conversations.length,
  });
});

// ─── START ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║        SMS-Gemini Bridge — Hackathon Edition             ║
╠══════════════════════════════════════════════════════════╣
║  Webhook: POST http://localhost:${PORT}/sms                ║
║  Status:  http://localhost:${PORT}/                        ║
║  Health:  http://localhost:${PORT}/health                  ║
╚══════════════════════════════════════════════════════════╝
  `);
});
