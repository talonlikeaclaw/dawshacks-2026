require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Setup Express server
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const RATE_LIMIT_SECONDS = parseInt(process.env.RATE_LIMIT_SECONDS || "10", 10);
const MAX_SMS_LENGTH = 320; // Keep responses under 320 chars when possible
const SYSTEM_PROMPT = `You are a helpful AI assistant reachable via SMS.
Keep responses SHORT and CONCISE (under 320 characters when possible).
Use simple language. No markdown formatting. Be friendly but brief.`;

// Twilio setup
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// In-memory state variables
// Recent messages to display on status page
const conversations = [];
// Map for phone numbers and last request timestamp
const rateLimitMap = new Map();
const MAX_CONVERSATIONS = 50;

/**
 * Shows only the last 4 digits of a phone number (+*******1234)
 * @param {number} phoneNumber - the phone number to anonymize
 */
function anonymizePhone(phoneNumber) {
  const cleaned = phone.replace(/\D/g, "");

  if (cleaned.length <= 4) {
    return "****" + cleaned;
  }
  return "+" + "*".repeat(cleaned.length - 4) + cleaned.slice(-4);
}

/**
 * Checks the rateLimitMap to see if we should rate limit request
 * @param {number} phoneNumber - the phone number to check the map for
 * @returns allowed: true/false depending on if need to rate limit
 */
function checkRateLimit(phoneNumber) {
  const now = Date.now();
  const last = rateLimitMap.get(phoneNumber);
  // checks of time since the last call is less than the rate‑limit window
  if (last && now - last < RATE_LIMIT_SECONDS * 1000) {
    const wait = Math.ceil((RATE_LIMIT_SECONDS * 1000 - (now - last)) / 1000);
    return { allowed: false, wait };
  }
  rateLimitMap.set(phoneNumber, now);
  return { allowed: true };
}

/**
 * Splits the SMS text messages into chunks
 * (SMS messages are limited to 160 character per message
 * or 153 for multi-part messages)
 * @param {string} text - the text to split into chunks
 */
function splitSms(text) {
  if (text.length <= 160) {
    return [text];
  }

  const segments = [];
  let remaining = text;
  // 153 - 8 = 145 chars max (messages prepend "(10/10) ")
  const chunkSize = 145;

  while (remaining.length > 0) {
    const cut = remaining.length > chunkSize ? chunkSize : remaining.length;
    segments.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  return segments;
}

/**
 * Sends an SMS message using Twilio client and console logs
 * @param {number} to - the number to send the text to
 * @param {string} body - the body text of the message to send
 */
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

// SMS Webhook
app.post("/sms", async (req, res) => {
  const { Body, From, MessageSid } = req.body;

  console.log(`[${new Date().toISOString()}] Webhook from ${From}: "${Body}"`);

  // Validate webhook
  if (!From || !Body) {
    console.error("Incorrect webhook format:", req.body);
    return res.status(400).send("<Response></Response>");
  }

  const messageBody = Body.trim();

  // Handle empty messages
  if (!messageBody) {
    console.log("Empty message from", From);
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
    await sendSms(
      From,
      `Whoa there! Wait ${rateCheck.wait}s before sending another message.`,
    );
    return res.status(200).type("text/xml").send("<Response></Response>");
  }
});
