require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const sqlite3 = require("sqlite3").verbose();

// Setup Express server
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const RATE_LIMIT_SECONDS = parseInt(process.env.RATE_LIMIT_SECONDS || "10", 10);
const SYSTEM_PROMPT = `You are a helpful AI assistant reachable via SMS.
Keep responses SHORT and CONCISE (under 320 characters when possible).
Use simple language. No markdown formatting. Be friendly but brief.`;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const WEATHER_GEO_BASE =
  process.env.WEATHER_API_BASE ||
  "https://api.openweathermap.org/geo/1.0/direct";
const WEATHER_DATA_BASE =
  process.env.WEATHER_DATA_BASE ||
  "https://api.openweathermap.org/data/2.5/weather";
const WEATHER_UNITS = process.env.WEATHER_UNITS || "metric";

// Twilio setup
const VOICE_SYSTEM_PROMPT = `You are a helpful AI assistant on a phone call.
Respond in natural spoken English only — no markdown, no bullet points, no lists.
Keep answers concise: 1–3 sentences max unless the user specifically asks for more detail.
Never say "bullet point" or use symbols like asterisks or dashes.
Be warm, clear, and direct.`;
// ─── CLIENTS ──────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// In-memory state variables

// Map for phone numbers and last request timestamp
const rateLimitMap = new Map();
const userState = new Map();

// SQLite setup
const db = new sqlite3.Database("./conversations.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `);
});

/**
 * Fetches the most recent conversations from the database
 * @param {number} limit - max number of records to return
 * @returns {Promise<Array>} recent conversation entries
 */
function getConversations(limit = 50) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM conversations ORDER BY time DESC LIMIT ?`,
      [limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      },
    );
  });
}

/**
 * Shows only the last 4 digits of a phone number (+*******1234)
 * @param {string} phoneNumber - the phone number to anonymize
 */
function anonymizePhone(phoneNumber) {
  const cleaned = phoneNumber.replace(/\D/g, "");

  if (cleaned.length <= 4) {
    return "****" + cleaned;
  }
  return "+" + "*".repeat(cleaned.length - 4) + cleaned.slice(-4);
}

/**
 * Checks the rateLimitMap to see if we should rate limit request
 * @param {string} phoneNumber - the phone number to check the map for
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
 * @returns the segmented text
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
 * @param {string} to - the number to send the text to
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

/**
 * Adds a new conversation entry to the database
 * @param {string} phoneNumber - the phone number related to the convo
 * @param {string} direction - the direction (inbound/outbound)
 * @param {string} body - the message body
 * @param {string} status - the status of the conversation
 * @returns {Promise<Object>} the created entry
 */
function addConversation(phoneNumber, direction, body, status, channel = "sms") {
  const entry = {
    id: Date.now() + Math.random().toString(36).slice(2, 7),
    time: new Date().toISOString(),
    phone: anonymizePhone(phoneNumber),
    direction, // 'inbound' | 'outbound'
    body: body.slice(0, 500),
    status, // 'success' | 'error' | 'rate-limited',
    channel, // 'sms' | 'voice'
  };

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO conversations (id, time, phone, direction, body, status, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.time,
        entry.phone,
        entry.direction,
        entry.body,
        entry.status,
        entry.channel,
      ],
      function (err) {
        if (err) return reject(err);
        resolve(entry);
      },
    );
  });
}

/**
 * Gets or creates a state object for a phone number.
 * This is stored in memory only and resets when the server restarts.
 * @param {string} phoneNumber - the phone number related to the user state
 * @returns {{ seenMenu: boolean, lastChoice: string | null, lastSeenAt: string | null }}
 */
function getUserState(phoneNumber) {
  if (!userState.has(phoneNumber)) {
    userState.set(phoneNumber, {
      seenMenu: false,
      lastChoice: null,
      lastSeenAt: null,
    });
  }

  return userState.get(phoneNumber);
}

/**
 * Fetches current weather for a city and optional country.
 * Uses OpenWeatherMap geocoding first, then the weather endpoint.
 * @param {string} city - city name from the SMS message
 * @param {string} country - optional country name or ISO code from the SMS message
 * @returns {Promise<{ ok: boolean, message: string, location?: string }>}
 */
async function getWeather(city, country = "") {
  const cleanedCity = String(city || "").trim();
  const cleanedCountry = String(country || "").trim();

  if (!cleanedCity) {
    return {
      ok: false,
      message: "Send a city name like: Weather Montreal Canada",
    };
  }

  if (!WEATHER_API_KEY) {
    return {
      ok: false,
      message: "Weather is not configured yet. Missing WEATHER_API_KEY.",
    };
  }

  try {
    const query = cleanedCountry
      ? `${cleanedCity}, ${cleanedCountry}`
      : cleanedCity;

    const geoUrl = new URL(WEATHER_GEO_BASE);
    geoUrl.searchParams.set("q", query);
    geoUrl.searchParams.set("limit", "1");
    geoUrl.searchParams.set("appid", WEATHER_API_KEY);

    const geoResponse = await fetch(geoUrl);
    if (!geoResponse.ok) {
      throw new Error(`Geocoding request failed (${geoResponse.status})`);
    }

    const geoData = await geoResponse.json();
    if (!Array.isArray(geoData) || geoData.length === 0) {
      return {
        ok: false,
        message: `Couldn't find weather for ${query}. Try: Weather Montreal Canada`,
      };
    }

    const location = geoData[0];
    const weatherUrl = new URL(WEATHER_DATA_BASE);
    weatherUrl.searchParams.set("lat", location.lat);
    weatherUrl.searchParams.set("lon", location.lon);
    weatherUrl.searchParams.set("appid", WEATHER_API_KEY);
    weatherUrl.searchParams.set("units", WEATHER_UNITS);

    const weatherResponse = await fetch(weatherUrl);
    if (!weatherResponse.ok) {
      throw new Error(`Weather request failed (${weatherResponse.status})`);
    }

    const weatherData = await weatherResponse.json();
    const description = weatherData?.weather?.[0]?.description || "unknown";
    const temp = Math.round(weatherData?.main?.temp);
    const feelsLike = Math.round(weatherData?.main?.feels_like);
    const humidity = weatherData?.main?.humidity;
    const cityName = location.name || cleanedCity;
    const countryName = location.country || cleanedCountry;
    const place = [cityName, countryName].filter(Boolean).join(", ");

    return {
      ok: true,
      location: place,
      message: `Weather for ${place}: ${temp}°${WEATHER_UNITS === "imperial" ? "F" : "C"}, feels like ${feelsLike}°, ${description}, humidity ${humidity}%.`,
    };
  } catch (err) {
    console.error("Weather API error:", err.message);
    return {
      ok: false,
      message:
        "Sorry, I couldn't fetch the weather right now. Try again in a moment.",
    };
  }
}

/**
 * Routes a menu choice (1/2/3/4) to the appropriate handler
 * text remainder is parsed as arguments for the handler
 * @param {string} phone - phone number
 * @param {string} choice - the menu choice ("1", "2", "3", or "4")
 * @param {string} args - optional remainder of the message (e.g., "Montreal Canada" for weather)
 * @returns {Promise<string>} the response message to send
 */
async function handleMenuChoice(phone, choice, args = "") {
  const cleanedChoice = String(choice || "").trim();
  const cleanedArgs = String(args || "").trim();

  switch (cleanedChoice) {
    case "1": {
      // Weather handler
      if (!cleanedArgs) {
        return "Send: 1 city country (e.g., 1 Montreal Canada)";
      }

      const parts = cleanedArgs.split(/\s+/);
      const city = parts[0];
      const country = parts.slice(1).join(" ");

      const result = await getWeather(city, country);
      return result.message;
    }

    case "2": {
      // News handler (stub)
      return "News coming soon! For now, try: 3 What's in the news today?";
    }

    case "3": {
      // General ask handler (stub showing they can ask anything)
      if (!cleanedArgs) {
        return "Ask me anything! e.g., 3 What's the capital of France?";
      }

      // Mark that we're handling a question; the webhook will handle it
      return null; // signals to the webhook to use Gemini
    }

    case "4": {
      // Help handler
      return [
        "Reachout AI Help:",
        "",
        "1 - Weather (1 city country)",
        "2 - News (coming soon)",
        "3 - Ask anything",
        "4 - This help",
        "",
        "Text MENU to restart.",
      ].join("\n");
    }

    default: {
      return "Invalid choice. Text 1, 2, 3, or 4. Text MENU for options.";
    }
  }
}

/**
 * Detects if the message is a menu keyword (for redisplaying the menu)
 * @param {string} message - the message body
 * @returns {boolean}
 */
function isMenuKeyword(message) {
  const normalized = message.trim().toUpperCase();
  return ["MENU", "START", "HELP", "?"].includes(normalized);
}

/**
 * Builds and returns the Reachout AI welcome menu as a string
 * @returns {string}
 */
function buildWelcomeMenu() {
  return [
    "Reachout AI",
    "",
    "Text a number to get started:",
    "1 - Weather",
    "2 - News",
    "3 - Ask a question",
    "4 - Help",
    "",
    "Reply with MENU anytime.",
  ].join("\n");
}

// SMS Webhook
app.post("/sms", async (req, res) => {
  const { Body, From } = req.body;

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
    await addConversation(From, "inbound", messageBody, "rate-limited");
    await sendSms(
      From,
      `Whoa there! Wait ${rateCheck.wait}s before sending another message.`,
    );
    return res.status(200).type("text/xml").send("<Response></Response>");
  }

  // Log inbound messages
  await addConversation(From, "inbound", messageBody, "success");

  const state = getUserState(From);

  // Check if user is asking for the menu (keyword) or if first-time user
  if (isMenuKeyword(messageBody) || !state.seenMenu) {
    state.seenMenu = true;
    state.lastChoice = "menu";
    state.lastSeenAt = new Date().toISOString();

    const menuText = buildWelcomeMenu();
    console.log(`Showing menu to ${From}`);
    await sendSms(From, menuText);
    await addConversation(From, "outbound", menuText, "success");
    return res.status(200).type("text/xml").send("<Response></Response>");
  }

  // Check if message starts with a menu choice (1/2/3/4)
  let geminiPrompt = messageBody;
  const firstChar = messageBody.charAt(0);
  if (["1", "2", "3", "4"].includes(firstChar)) {
    const choice = firstChar;
    const args = messageBody.slice(1).trim();

    console.log(`Menu choice ${choice} from ${From} with args: "${args}"`);

    const handlerResponse = await handleMenuChoice(From, choice, args);

    // If handler returns null, it means use Gemini for option 3
    if (handlerResponse === null) {
      geminiPrompt = args; // strip the "3 " prefix before sending to Gemini
    } else {
      // Send the handler's response
      state.lastChoice = choice;
      state.lastSeenAt = new Date().toISOString();

      const segments = splitSms(handlerResponse);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const prefix =
          segments.length > 1 ? `(${i + 1}/${segments.length}) ` : "";
        await sendSms(From, prefix + segment);
      }

      await addConversation(From, "outbound", handlerResponse, "success");
      return res.status(200).type("text/xml").send("<Response></Response>");
    }
  }

  // Fallback: treat as free-form question to Gemini
  try {
    // Call Gemini AI
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: SYSTEM_PROMPT + "\n\nUser: " + geminiPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
      },
    });

    const aiText = result.response.text().trim();
    console.log(`Gemini response for ${From}: "${aiText.slice(0, 80)}..."`);

    state.lastChoice = "ask";
    state.lastSeenAt = new Date().toISOString();

    // Send response(s)
    const segments = splitSms(aiText);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const prefix =
        segments.length > 1 ? `(${i + 1}/${segments.length}) ` : "";
      await sendSms(From, prefix + segment);
    }

    // Log outbound
    await addConversation(From, "outbound", aiText, "success");
  } catch (err) {
    console.error("Gemini API error:", err.message);
    await addConversation(From, "outbound", "", "error");
    await sendSms(
      From,
      "Sorry, the AI is having trouble right now. Try again in a moment!",
    );
  }

  res.status(200).type("text/xml").send("<Response></Response>");
});

// Admin API endpoint: Returns recent conversations as JSON
// Optional query param: ?limit=N (defaults to 50)
app.get("/api/conversations", async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
  try {
    const rows = await getConversations(limit);
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err.message);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// ─── VOICE FUNCTIONS & WEBHOOKS ──────────────────────────────────────────────────────

function buildVoiceLoop(text, actionPath){
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: actionPath,
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    language: 'en-US',
  });
  gather.say(text, { voice: 'Polly.Joanna', language: 'en-US' });
  return twiml.toString();
}

app.post("/voice", (req, res) => {
  const { CallSid, From } = req.body;
  console.log(`[${new Date().toISOString()}] Incoming call from ${From} - CallSid: ${CallSid}`);

  //start new voice session
  callSessions.set(CallSid, { history: [], phone: From });
  addConversation(From, "inbound", "[Voice Call Started]", "success", "voice");

  //respond using twiML and listens, then sends to /voice/respond 
  res.type("text/xml").send(buildVoiceLoop(
    "Hi! I'm your AI assistant. What can I help you with?",
    "/voice/respond"
  ));
});

app.post("/voice/respond", async (req, res) => {
  const { CallSid, From, SpeechResult } = req.body;
  console.log(`[${new Date().toISOString()}] Voice input from ${From} - CallSid: ${CallSid} - SpeechResult: "${SpeechResult}"`);

  //get voice session history
  const { history } = callSessions.get(CallSid);

  const userText = SpeechResult.trim();
  addConversation(From, "inbound", userText, "success", "voice");
  
  //add user input to history
  history.push({ role: "user", parts: [{ text: userText }] });

  //build contents of prompt to gemini, including system prompt and conversation history
  const contents = [
    {
      role: "user",
      parts: [{ text: VOICE_SYSTEM_PROMPT }],
    },
    {
      role: "model",
      parts: [{ text: "Understood. I'll keep my answers short and spoken naturally."}]
    },
    ...history,
  ];

  try{
    const result = await model.generateContent({
      contents,
      generationConfig: {
        temperature: 0.7,
      },
    });
    //get gemini reply
    const reply = result.response.text().trim();
    console.log(`Gemini voice response for ${From}: "${reply.slice(0, 80)}..."`);

    //add model reply to history
    history.push({ role: "model", parts: [{ text: reply }] });
    callSessions.get(CallSid).history = history;

    addConversation(From, "outbound", reply, "success", "voice");

    //restart conversation loop
    res.type("text/xml").send(buildVoiceLoop(reply, "/voice/respond"));
  } catch (err) {
    console.error("Gemini API error:", err.message);
    addConversation(From, "outbound", "", "error", "voice");
    res.type("text/xml").send(
      buildVoiceLoop("Sorry, the AI is having trouble right now. Try again in a moment!", 
      "/voice/respond"
    ));
  }
});  

// Run the Express server :D

app.listen(PORT, () => {
  console.log("Reachout server (SMS - Gemini Bridge)");
  console.log(`Webhook: POST http://localhost:${PORT}/sms`);
  console.log(`Status:  http://localhost:${PORT}/`);
});
