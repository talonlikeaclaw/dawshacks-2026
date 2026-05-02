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
 * Splits the SMS text messages into chunks
 * (SMS messages are limited to 160 character per message
 * or 153 for multi-part messages)
 * @param {string} text
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
