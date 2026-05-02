# Reachout

Text any question to a phone number, get an AI response from Google's Gemini — no app, no internet, just SMS. Built for feature phones and the 2.7 billion people without smartphones.

## Quick Start (5 minutes)

### 1. Get Your API Keys

**Google Gemini API Key:**

1. Go to [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the key

**Twilio Account:**

1. Sign up at [twilio.com/try-twilio](https://www.twilio.com/try-twilio) (free $15.50 credit)
2. Get your Account SID and Auth Token from the [console dashboard](https://console.twilio.com/)
3. Buy a phone number ($1/month, comes with free credit)

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

### 5. Configure Twilio Webhook

1. Go to [Twilio Console → Phone Numbers → Manage → Active numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. Click your number
3. Under "Messaging", set:
   - **Configure with:** Webhooks, TwiML Bins, Functions, Studio, or Proxy
   - **A message comes in:** Webhook → `https://your-ngrok-url.ngrok.io/sms`
   - **HTTP method:** POST
4. Save

### 6. Test

Text your Twilio number: _"What is the capital of France?"_

You should get a reply within 5-10 seconds.

## Demo Day Setup

1. Start the server: `npm start`
2. Start ngrok: `ngrok http 3000`
3. Update Twilio webhook to the new ngrok URL
4. Open `http://localhost:3000` on the projector for the live status feed
5. Have your feature phone ready to text!

**Pro tip:** ngrok URLs change every time you restart it. For a stable demo URL, use ngrok's paid plan ($5/month) or deploy to Render/Railway/Heroku.

## Project Structure

```
.
├── server.js          # Single-file backend (webhook + status page + rate limiting)
├── package.json       # Dependencies
├── .env.example       # Environment variable template
└── README.md          # This file
```

## How It Works

```
[Feature Phone SMS]
       ↓
[Twilio Phone Number]
       ↓ (webhook POST)
[Your Server /sms]
       ↓
[Gemini 1.5 Flash API]
       ↓
[Twilio SMS API]
       ↓
[Feature Phone Display]
```

## Cost Estimate

| Service             | Cost            | Notes                           |
| ------------------- | --------------- | ------------------------------- |
| Twilio Phone Number | $1.00/month     | One number                      |
| Twilio Inbound SMS  | $0.0075/message | US pricing                      |
| Twilio Outbound SMS | $0.0075/message | US pricing                      |
| Gemini API          | **FREE**        | 1,500 requests/day on free tier |
| **Total for demo**  | ~$0.30          | Assuming ~20 text exchanges     |

## Features

- **Webhook endpoint** (`POST /sms`) — receives Twilio SMS, calls Gemini, replies
- **Live status page** (`GET /`) — auto-refreshing feed of recent conversations with anonymized phone numbers
- **Rate limiting** — 10 seconds between requests per phone number
- **Smart SMS splitting** — long responses split into multiple 153-character segments
- **Error handling** — graceful failures for Gemini downtime, empty messages, malformed webhooks
- **Anonymized logs** — only last 4 digits of phone numbers shown on status page

## Environment Variables

| Variable              | Required | Description                                       |
| --------------------- | -------- | ------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`  | Yes      | From Twilio console                               |
| `TWILIO_AUTH_TOKEN`   | Yes      | From Twilio console                               |
| `TWILIO_PHONE_NUMBER` | Yes      | Your Twilio number (E.164 format)                 |
| `GEMINI_API_KEY`      | Yes      | From Google AI Studio                             |
| `PORT`                | No       | Server port (default: 3000)                       |
| `RATE_LIMIT_SECONDS`  | No       | Seconds between requests per number (default: 10) |

## Troubleshooting

**Twilio says "Webhook timeout"**

- Make sure ngrok is running and the URL is correct in Twilio settings
- Check that your server is actually running on the port ngrok is forwarding

**"Invalid API key" errors**

- Double-check your Gemini API key — it should start with `AI...`
- Ensure the key hasn't expired or hit its daily limit

**Messages not splitting correctly**

- The app splits at 153 chars for multi-part SMS. If you see weird breaks, Gemini is likely outputting very long responses. The system prompt asks it to stay under 320 chars.

**Rate limit too aggressive/lenient**

- Adjust `RATE_LIMIT_SECONDS` in your `.env` file

## License

MIT — hack away!
