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
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const WEATHER_GEO_BASE =
  process.env.WEATHER_API_BASE ||
  "https://api.openweathermap.org/geo/1.0/direct";
const WEATHER_DATA_BASE =
  process.env.WEATHER_DATA_BASE ||
  "https://api.openweathermap.org/data/2.5/weather";
const WEATHER_UNITS = process.env.WEATHER_UNITS || "metric";

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
// Map for per-user menu state and lightweight SMS session info
const userState = new Map();
const MAX_CONVERSATIONS = 50;

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
 *
 * @param {string} phoneNumber - the phone number related to the convo
 * @param {string} direction - the direction (inbound/outbound)
 * @param {string} body - the message body
 * @param {string} status - the status of the conversation
 */
function addConversation(phoneNumber, direction, body, status) {
  const entry = {
    id: Date.now() + Math.random().toString(36).slice(2, 7),
    time: new Date().toISOString(),
    phone: anonymizePhone(phoneNumber),
    direction, // 'inbound' | 'outbound'
    body: body.slice(0, 500),
    status, // 'success' | 'error' | 'rate-limited'
  };
  conversations.unshift(entry);
  if (conversations.length > MAX_CONVERSATIONS) {
    conversations.pop();
  }
  return entry;
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
      message: "Sorry, I couldn't fetch the weather right now. Try again in a moment.",
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
    addConversation(From, "inbound", messageBody, "rate-limited");
    await sendSms(
      From,
      `Whoa there! Wait ${rateCheck.wait}s before sending another message.`,
    );
    return res.status(200).type("text/xml").send("<Response></Response>");
  }

  // Log inbound messages
  addConversation(From, "inbound", messageBody, "success");

  const state = getUserState(From);

  // Check if user is asking for the menu (keyword) or if first-time user
  if (isMenuKeyword(messageBody) || !state.seenMenu) {
    state.seenMenu = true;
    state.lastChoice = "menu";
    state.lastSeenAt = new Date().toISOString();

    const menuText = buildWelcomeMenu();
    console.log(`Showing menu to ${From}`);
    await sendSms(From, menuText);
    addConversation(From, "outbound", menuText, "success");
    return res.status(200).type("text/xml").send("<Response></Response>");
  }

  // Check if message starts with a menu choice (1/2/3/4)
  const firstChar = messageBody.charAt(0);
  if (["1", "2", "3", "4"].includes(firstChar)) {
    const choice = firstChar;
    const args = messageBody.slice(1).trim();

    console.log(`Menu choice ${choice} from ${From} with args: "${args}"`);

    const handlerResponse = await handleMenuChoice(From, choice, args);

    // If handler returns null, it means use Gemini for option 3
    if (handlerResponse === null) {
      // Fall through to Gemini below
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

      addConversation(From, "outbound", handlerResponse, "success");
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
          parts: [{ text: SYSTEM_PROMPT + "\n\nUser: " + messageBody }],
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

// Run the Express server :D
app.listen(PORT, () => {
  console.log("Reachout server (SMS - Gemini Bridge)");
  console.log(`Webhook: POST http://localhost:${PORT}/sms`);
  console.log(`Status:  http://localhost:${PORT}/`);
});
