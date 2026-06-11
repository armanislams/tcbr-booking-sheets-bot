# 📊 Google Sheets Monitor Bot

A robust Node.js bot that monitors a Google Sheet on a schedule, detects new or modified rows, notifies you on Telegram, and serves a beautiful real-time Web Dashboard.

---

## ✨ Features

- **🟢 New Row Detection**: Detects new rows added this month (based on check-in date in Column H and check-out date in Column I).
- **🟡 Modified Row Tracking**: Detects cell modifications in existing rows and logs what changed.
- **📱 Rich Telegram Alerts**:
  - For new rows, sends a detailed summary of all row data.
  - For modified rows, sends the **full row data** (with changed fields highlighted with a `🟡 (changed)` badge) and a detailed **What Changed** comparison block.
- **🌐 Real-Time Dashboard**: Interactive UI hosted locally or on the cloud showing statistics, filters, search, and a visual changelog.
- **💾 Dual Storage Modes**:
  - **Local Mode (Default)**: Persists data to local JSON files (`data/snapshot.json` and `data/change_history.json`).
  - **Production Mode**: Connects to **MongoDB** for persistent storage across cloud server restarts.

---

## 🚀 Quick Start

### Step 1 — Install Dependencies
Clone the repository and install the Node.js packages:
```bash
npm install
```

### Step 2 — Set up Google Cloud Credentials
To allow the bot to read your Google Sheet:
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g. `sheets-bot`).
3. Navigate to **APIs & Services > Library**, search for **Google Sheets API**, and enable it.
4. Go to **APIs & Services > Credentials**, click **+ Create Credentials**, and select **Service Account**.
5. Give it a name and click **Done**.
6. Click on your newly created service account, go to the **Keys** tab, click **Add Key > Create new key**, choose **JSON**, and download it.
7. Rename the downloaded file to `service-account.json` and place it in the project root directory.
8. Copy your Service Account email (e.g. `sheets-reader@your-project.iam.gserviceaccount.com`).
9. Open your Google Sheet, click **Share** (top-right), paste the service account email, set the permission to **Viewer**, and share it.

### Step 3 — Configure Settings
Copy the environment template file:
```bash
copy .env.example .env
```
Open `.env` and fill in the values:
```env
# Google Sheets ID (found in your Sheet URL: https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit)
GOOGLE_SHEET_ID=your_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json

# Telegram Credentials (get BOT_TOKEN from @BotFather)
TELEGRAM_BOT_TOKEN=8639701436:AA...
TELEGRAM_CHAT_ID=-1003950...

# Scheduler Interval (cron format, e.g., '0 * * * *' for hourly checks)
CHECK_INTERVAL_CRON=0 * * * *

# Web Dashboard Port
DASHBOARD_PORT=5000

# (Optional) MongoDB Connection String for production persistence
MONGODB_URI=mongodb+srv://...
```

### Step 4 — Run the Bot
To start the bot in development mode (with watch reload):
```bash
npm run dev
```
To run the bot in production:
```bash
npm start
```
The dashboard will be available at `http://localhost:5000` (or your configured port).

---

## 💾 Storage & Database Modes

The bot automatically selects its storage mode based on your configuration:
- **Local Fallback**: If no `MONGODB_URI` environment variable is defined, snapshot and history logs are written locally to the `/data` directory.
- **MongoDB Production**: If `MONGODB_URI` is provided, the bot uses a cloud MongoDB cluster. This is **critical** for hosting services like Render, which wipe local disk changes when container instances restart.
- **Dashboard Indicator**: The dashboard UI displays a connection status badge (`DB: Connected` or `DB: Local Fallback`) to let you monitor the database state.

---

## ☁️ Deploying to Render

This repository includes a `render.yaml` blueprint file for easy deployment as a **Web Service**.

1. Connect your GitHub repository to [Render](https://render.com/).
2. Create a new **Web Service** using the blueprint.
3. Configure the environment variables in the Render dashboard:
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_KEY` (or paste JSON as value if using key injection)
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `MONGODB_URI`
   - `CHECK_INTERVAL_CRON` (e.g., `0 * * * *` for hourly)
   - `DASHBOARD_PORT` (`10000` for Render)

### ⚠️ Render Free Tier Keep-Alive (Avoid Sleep Mode)
On the Render **Free Plan**, Web Services automatically go to sleep after **15 minutes of inactivity** (no incoming HTTP requests). When it sleeps, the bot's scheduled hourly checks will not run.

To keep your bot awake 24/7 for free:
1. Go to [UptimeRobot.com](https://uptimerobot.com/) (or [Cron-Job.org](https://cron-job.org/)).
2. Register for a free account.
3. Click **Add New Monitor** and set:
   - **Monitor Type**: `HTTPS`
   - **Friendly Name**: `Sheets Bot Keep-Alive`
   - **URL**: `https://your-render-app-url.onrender.com/api/status`
   - **Monitoring Interval**: `5 minutes` (or `10 minutes`)
4. Save the monitor. This continuously pings your bot's health check API to prevent it from going to sleep.

---

## 📁 Project Structure

```
sheets-bot/
├── index.js              ← Main scheduler and check loop coordinator
├── src/
│   ├── sheets.js         ← Google Sheets API interface
│   ├── detector.js       ← Diff and change detection logic
│   ├── telegram.js       ← Telegram notification formatter
│   ├── snapshot.js       ← Local JSON / MongoDB storage interface
│   └── dashboard.js      ← Express dashboard API server
├── public/
│   └── index.html        ← Front-end dashboard UI
├── data/
│   ├── snapshot.json     ← Local baseline snapshot (Local fallback)
│   └── change_history.json ← Local changelog history (Local fallback)
├── render.yaml           ← Render deployment configuration
├── package.json          ← Node metadata and dependencies
└── .env                  ← Local environment secrets (never commit)
```

---

## 🔒 Security Note
- Never commit `service-account.json` or `.env` files to git.
- Keep your Google Cloud JSON keys secure.
