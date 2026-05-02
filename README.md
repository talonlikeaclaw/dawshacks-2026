# Reachout AI

Reachout AI bridges the gap between the [2.7 billion people without smartphones](https://www.bankmycell.com/blog/how-many-phones-are-in-the-world) or reliable internet access and modern AI; using nothing but SMS. Text or call a question to a phone number, get an AI response. No app. No data plan. No smartphone required.

Built for "dumb" phones, rural communities, and anyone priced out of the AI revolution.

Made with help from AI.

## Quick Start

### 1. Get Your API Keys

**Google Gemini API Key:**

1. Go to [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the key

**Twilio Account:**

1. Sign up at [twilio.com/try-twilio](https://www.twilio.com/try-twilio) (free $15.50 credit)
2. Get your Account SID and Auth Token from the [console dashboard](https://console.twilio.com/)
3. Buy a phone number ($1/month, comes with free credit)

**OpenWeatherMap API Key:**

1. Sign up at [openweathermap.org/api](https://openweathermap.org/api)
2. Copy your API key from the dashboard (free tier: 1,000 calls/day)

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1234567890
GEMINI_API_KEY=AIxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WEATHER_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. Install & Run

```bash
npm install
npm start
```

Server starts on `http://localhost:3000`

### 4. Expose with ngrok (for Twilio webhooks)

```bash
# Install ngrok if needed: https://ngrok.com/download
ngrok http 3000
```

Copy the HTTPS URL (e.g. `https://abc123.ngrok.io`)

### 5. Configure Twilio Webhooks

1. Go to [Twilio Console → Phone Numbers → Manage → Active numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. Click your number
3. Under **Messaging**, set:
   - **A message comes in:** Webhook → `https://your-ngrok-url.ngrok.io/sms` (POST)
4. Under **Voice**, set:
   - **A call comes in:** Webhook → `https://your-ngrok-url.ngrok.io/voice` (POST)
   - **Call status changes:** Webhook → `https://your-ngrok-url.ngrok.io/voice/end` (POST)
5. Save

### 6. Test

**SMS:** Text your Twilio number `MENU`: you'll get the option list.

**Voice:** Call your Twilio number and speak your question after the greeting.

## How It Works

### SMS

```
[Feature Phone SMS]
       ↓
[Twilio Phone Number]
       ↓ (webhook POST /sms)
[Your Server]
       ↓
[Menu Router]
   ├── 1 → OpenWeatherMap API
   ├── 2 → Gemini 2.5 Flash API
   └── 3 → Help text
       ↓
[Twilio SMS API]
       ↓
[Feature Phone Display]
```

### Voice

```
[Any Phone Call]
       ↓
[Twilio Phone Number]
       ↓ (webhook POST /voice)
[Your Server — greets caller]
       ↓
[Twilio speech-to-text]
       ↓ (webhook POST /voice/respond)
[Gemini 2.5 Flash — with full call history]
       ↓
[Twilio text-to-speech (Polly.Joanna)]
       ↓ (loops back until call ends)
[Caller hears response]
```

## SMS Menu System

First-time users and anyone who texts `MENU`, `START`, `HELP`, or `?` gets the main menu:

```
Reachout AI

Text a number to get started:
1 - Weather
2 - Ask a question
3 - Help
```

| Option | Usage               | Example                  |
| ------ | ------------------- | ------------------------ |
| `1`    | Weather for a city  | `1 Montreal Canada`      |
| `2`    | Ask Gemini anything | `2 What causes thunder?` |
| `3`    | Help / command list | `3`                      |

Messages that don't start with 1–3 are sent directly to Gemini as free-form questions.

## Project Structure

```
.
├── server.js          # Single-file backend (SMS + voice + menu router + DB)
├── conversations.db   # SQLite database (auto-created on first run)
├── package.json       # Dependencies
├── .env.example       # Environment variable template
└── README.md          # This file
```

## API Endpoints

| Endpoint             | Method | Description                                        |
| -------------------- | ------ | -------------------------------------------------- |
| `/sms`               | POST   | Twilio SMS webhook — receives and responds via SMS |
| `/voice`             | POST   | Twilio voice webhook — greets caller               |
| `/voice/respond`     | POST   | Handles speech input, calls Gemini, speaks reply   |
| `/voice/end`         | POST   | Cleans up call session on hang-up                  |
| `/api/conversations` | GET    | Recent conversations as JSON (SMS + voice)         |

The conversations endpoint accepts an optional `?limit=N` query param (default: 50):

```bash
curl http://localhost:3000/api/conversations
curl "http://localhost:3000/api/conversations?limit=10"
```

## Features

- **SMS menu system** — guided interface with weather, AI chat, and help
- **Voice calling** — call the number and have a spoken conversation with Gemini
- **Multi-turn voice conversations** — call history is maintained for the duration of the call
- **First-time auto-menu** — new SMS users see the menu automatically
- **Free-form fallback** — SMS messages not starting with 1–3 go directly to Gemini
- **Weather lookup** (`1 city country`) — current conditions via OpenWeatherMap
- **AI chat** (`2 question` or just speak) — answered by Gemini 2.5 Flash
- **Conversation history** — all SMS and voice interactions stored in SQLite by channel
- **Admin API** (`GET /api/conversations`) — recent conversations as JSON with optional limit
- **Rate limiting** — 10 seconds between SMS requests per phone number
- **Smart SMS splitting** — long responses split into numbered 153-character segments
- **Anonymized logs** — only last 4 digits of phone numbers stored
- **In-memory session state** — tracks whether each number has seen the SMS menu; resets on server restart

## Environment Variables

| Variable              | Required | Description                                           |
| --------------------- | -------- | ----------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`  | Yes      | From Twilio console                                   |
| `TWILIO_AUTH_TOKEN`   | Yes      | From Twilio console                                   |
| `TWILIO_PHONE_NUMBER` | Yes      | Your Twilio number (E.164 format)                     |
| `GEMINI_API_KEY`      | Yes      | From Google AI Studio                                 |
| `WEATHER_API_KEY`     | No       | From OpenWeatherMap — weather won't work without it   |
| `PORT`                | No       | Server port (default: 3000)                           |
| `RATE_LIMIT_SECONDS`  | No       | Seconds between SMS requests per number (default: 10) |
| `WEATHER_UNITS`       | No       | `metric` or `imperial` (default: metric)              |
| `WEATHER_API_BASE`    | No       | Override OpenWeatherMap geocoding URL                 |
| `WEATHER_DATA_BASE`   | No       | Override OpenWeatherMap weather data URL              |

## License

MIT
