# 📊 Google Sheets Monitor Bot

A Node.js bot that monitors your Google Sheet every hour and:
- 🟢 Detects **new rows** added this month (check-in col H / check-out col I)
- 🟡 Detects **modified cells** in existing rows
- 📱 Sends a **Telegram message** with a summary of changes
- 🌐 Provides a **web dashboard** at `http://localhost:3000`

---

## 🚀 Quick Start

### Step 1 — Install Node dependencies

```bash
npm install
```

---

### Step 2 — Set up Google Cloud (one-time)

You need a **Service Account** to read your Google Sheet. This is free.

#### 2a. Create a Google Cloud Project
1. Go to https://console.cloud.google.com/
2. Click **"Select a project"** → **"New Project"**
3. Name it anything (e.g. `sheets-bot`) and click **Create**

#### 2b. Enable the Google Sheets API
1. In the Google Cloud Console, go to **APIs & Services → Library**
2. Search for **"Google Sheets API"**
3. Click it → Click **"Enable"**

#### 2c. Create a Service Account
1. Go to **APIs & Services → Credentials**
2. Click **"+ Create Credentials"** → **"Service Account"**
3. Give it a name (e.g. `sheets-reader`) → Click **Create and Continue**
4. Skip the optional role steps → Click **Done**

#### 2d. Download the JSON Key
1. In the Credentials list, click your new service account
2. Go to the **Keys** tab → **Add Key** → **Create new key**
3. Choose **JSON** → Click **Create**
4. A `.json` file downloads — **rename it to `service-account.json`**
5. **Move it into this project folder** (next to `index.js`)

#### 2e. Share your Google Sheet with the Service Account
1. Open your service account in Google Cloud Console
2. Copy the **email address** (looks like `sheets-reader@your-project.iam.gserviceaccount.com`)
3. Open your Google Sheet
4. Click **Share** (top-right)
5. Paste the service account email → Set permission to **Viewer** → Click **Share**

---

### Step 3 — Configure your `.env` file

Copy the template and fill in your values:

```bash
copy .env.example .env
```

Then open `.env` and fill in:

```env
# Paste the part from your Sheet URL:
# https://docs.google.com/spreadsheets/d/THIS_PART/edit
GOOGLE_SHEET_ID=your_sheet_id_here

GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json

# Your Telegram bot token (from @BotFather)
TELEGRAM_BOT_TOKEN=123456789:ABCdef...

# Your Telegram chat/group ID
# To get your chat ID: message your bot, then open:
# https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
# Look for "chat":{"id": THIS_NUMBER}
TELEGRAM_CHAT_ID=123456789

DASHBOARD_PORT=3000
```

---

### Step 4 — Run the bot

```bash
npm start
```

You should see:
```
🤖 Sheets Monitor Bot starting...
🌐 Dashboard running at http://localhost:3000
⏱  Running scheduled check...
   📋 Reading tab: "Sheet1"
   📄 Fetched 42 total rows from sheet
   📅 Current month rows: 12
   🟢 New rows: 0
   🟡 Modified rows: 0
   ✅ No changes detected.
📆 Scheduler set: "0 * * * *"
👋 Bot is running. Press Ctrl+C to stop.
```

---

## 🧪 Testing

To test notifications immediately (don't wait 1 hour), change `.env`:
```env
CHECK_INTERVAL_CRON=*/1 * * * *
```
This checks every minute. Then add a row to your sheet and watch for a Telegram message.

---

## 📁 Project Structure

```
sheets-bot/
├── index.js              ← Main entry point (scheduler)
├── src/
│   ├── sheets.js         ← Google Sheets API
│   ├── detector.js       ← Change detection logic
│   ├── telegram.js       ← Telegram notifications
│   ├── snapshot.js       ← Snapshot & history storage
│   └── dashboard.js      ← Express web server
├── public/
│   └── index.html        ← Web dashboard UI
├── data/
│   ├── snapshot.json     ← Auto-generated (current state)
│   └── change_history.json ← Auto-generated (event log)
├── service-account.json  ← Your Google key (NEVER share this)
├── .env                  ← Your secrets (NEVER commit this)
└── .env.example          ← Template
```

---

## 🔒 Security Note

Never commit `service-account.json` or `.env` to git. Add them to `.gitignore`:
```
.env
service-account.json
data/
```

---

## 🛠 Troubleshooting

| Error | Fix |
|---|---|
| `GOOGLE_SHEET_ID is not set` | Check your `.env` file |
| `The caller does not have permission` | Make sure you shared the sheet with the service account email |
| `Could not load the default credentials` | Check the path to `service-account.json` in `.env` |
| `Telegram notification not sent` | Verify your bot token and chat ID |
