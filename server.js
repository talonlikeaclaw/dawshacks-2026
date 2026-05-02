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
