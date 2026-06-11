# 📊 Google Sheets Monitor Bot

A robust, production-grade Node.js service that monitors a Google Sheet on a schedule, detects new or modified rows, triggers detailed HTML alerts on Telegram, and hosts a beautiful real-time Web Dashboard.

Designed for reliability and cloud persistence, the bot automatically handles network disconnects, tracks downtime recovery, splits long messages, and supports dual storage modes (Local JSON files or MongoDB).

---

## ✨ Features

- 📅 **Intelligent Change Detection**:
  - **New Row Detection**: Automatically identifies new booking rows where the Check-In Date falls within the current calendar month and year.
  - **Modified Row Tracking**: Detects cell-by-cell modifications in existing bookings, highlighting exactly what changed.
  - **Auto-Header Detection**: Dynamically scans the first 10 rows of the sheet to locate the header row (identifying it by the cell `'CODE'`), failing back gracefully to the first row if not found.
  - **Flexible Date Parsing**: Recognizes common date formats (e.g., `dd/mm/yyyy`, `yyyy-mm-dd`) as well as textual entries with ordinal suffixes and minor typos (e.g., `"20th March"`, `"2nd June"`, `"24thJuly"`, `"17th Marcj"`).
- 📱 **Rich Telegram Alerts**:
  - **New Bookings**: Sends a structured HTML list detailing all columns of the new row.
  - **Modified Bookings**: Sends the full row data with modified fields highlighted by a `🟡 (changed)` badge alongside a dedicated **What Changed** comparison block.
  - **Downtime Recovery Alert**: If the bot is offline or inactive for more than 10 minutes, it calculates the downtime duration and includes a reconnection report when it boots back up.
  - **Payload Protection**: Automatically splits notifications exceeding Telegram's 4096-character limit into multiple sequentially delivered chunks.
  - **Error Alerts**: Direct notification of sheet access issues or database errors.
- 🌐 **Real-Time Web Dashboard**:
  - **Change Log Tab**: A comprehensive visual audit trail of all check events, rows added, columns modified, and error logs with expandable cards and custom status badges.
  - **Current Month Bookings Tab**: Interactive table displaying all active bookings for the current month.
  - **All Bookings Tab**: Displays every recorded booking from the Google Sheet snapshot with a **Month Filter** dropdown to view entries for specific months.
  - **High Performance**: Features a debounced real-time search bar, date filters (filter by Check-In or Check-Out dates), database status badges, and lazy rendering client-side pagination to handle thousands of rows with zero lag.
- 💾 **Dual Storage & Persistence**:
  - **Local Fallback Mode**: Persists snapshots and change history to local JSON files (`data/snapshot.json` and `data/change_history.json`).
  - **MongoDB Production Mode**: Automatically switches to MongoDB for database persistence if a connection URI is provided. Essential for serverless or container environments (like Render) with ephemeral local filesystems.
  - **In-Memory Cache**: Uses a 30-second TTL cache for snapshots and history loading, reducing database/disk overhead during high dashboard traffic.

---

## 📂 Project Structure

```
sheets-bot/
├── index.js                # Core coordinator (initialization, scheduling, check loop)
├── package.json            # Node.js dependencies and run scripts
├── render.yaml             # Render.com infrastructure blueprint
├── .env.example            # Environment variables configuration template
├── src/
│   ├── sheets.js           # Google Sheets API connection and raw data fetcher
│   ├── detector.js         # Date parsing, header detection, and diff logic
│   ├── telegram.js         # Telegram HTML message builders and chunk sender
│   ├── snapshot.js         # Storage controller (Local JSON / MongoDB, caching)
│   └── dashboard.js        # Express API server hosting dashboard endpoints
├── public/
│   └── index.html          # Single-page real-time HTML/CSS/JS web dashboard
└── data/                   # Git-ignored local snapshot backup folder
    ├── snapshot.json       # Baseline local snapshot (Local Fallback Mode)
    └── change_history.json # Local change history ledger (Local Fallback Mode)
```

---

## ⚙️ Environment Variables

The bot is configured using environment variables. Copy `.env.example` to `.env` in the root directory and update the values:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `GOOGLE_SHEET_ID` | **Yes** | The unique ID of the Google Sheet (extracted from its URL). |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | *Optional* | Local relative path to your service account JSON file (defaults to `./service-account.json`). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | *Optional* | The raw stringified JSON content of your Google Service Account key (preferred for cloud services). |
| `TELEGRAM_BOT_TOKEN` | **Yes** | Your Telegram Bot token obtained from `@BotFather`. |
| `TELEGRAM_CHAT_ID` | **Yes** | The Telegram chat or channel ID where notifications should be posted. |
| `CHECK_INTERVAL_CRON` | No | Cron expression specifying check interval (defaults to hourly: `0 * * * *`). |
| `DASHBOARD_PORT` | No | The port the Express Dashboard server listens on (defaults to `3000`). |
| `MONGODB_URI` | No | MongoDB connection string (e.g. Atlas). Enables **MongoDB Production Mode**. |

---

## 🚀 Quick Start Guide

### Step 1: Install Dependencies
Clone the repository and install the Node.js packages:
```bash
npm install
```

### Step 2: Set up Google Sheets Credentials
To read your Google Sheet programmatically:
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Search for **Google Sheets API** in the API Library and click **Enable**.
4. Navigate to **APIs & Services > Credentials**, click **+ Create Credentials**, and choose **Service Account**.
5. Give the Service Account a name and click **Create and Continue**, then **Done**.
6. Find your new Service Account in the list, click on it, open the **Keys** tab, click **Add Key > Create new key**, select **JSON**, and download the file.
7. Rename the downloaded file to `service-account.json` and place it in the root folder of this project.
8. Copy the Service Account email address (e.g., `bot-reader@project-id.iam.gserviceaccount.com`).
9. Open your Google Sheet in a browser, click the **Share** button (top right), paste the Service Account email, set its permission to **Viewer**, and click **Share**.

### Step 3: Set up Telegram Bot
To receive real-time notifications on Telegram:
1. Contact `@BotFather` on Telegram and send the `/newbot` command.
2. Follow the prompts to name your bot and copy the API token (e.g., `8639701436:AA...`).
3. Create a Telegram Channel or Group, add your bot as an Administrator, and write a test message.
4. Retrieve your chat ID. You can send a message in the channel and query `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` to find the `"chat":{"id": -100xxxxxxxxxx}` property.

### Step 4: Set up MongoDB (Recommended for Production)
For production deployments like Render, local filesystems are ephemeral (recreated on every restart/deploy). To keep your snapshot data and change history persistent:
1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Under **Database Access**, create a user with read/write privileges.
3. Under **Network Access**, allow access from all IPs (`0.0.0.0/0`) or configure specific IP ranges.
4. Click **Connect**, choose **Drivers**, and copy the connection string.
5. Replace `<password>` and `<username>` in the connection string and assign it to `MONGODB_URI` in your configuration.

### Step 5: Configure Settings
Create your `.env` configuration file:
```bash
cp .env.example .env
```
Open `.env` and fill in all variables retrieved from the steps above.

### Step 6: Run the Bot
To start the bot in development mode with automatic reload:
```bash
npm run dev
```
To run the bot in production mode:
```bash
npm start
```
Once started, the Express dashboard will be hosted at `http://localhost:3000` (or your configured `DASHBOARD_PORT`).

---

## ☁️ Deploying to Render.com

This repository contains a `render.yaml` configuration that allows you to deploy the service as a **Web Service** with a single click.

1. Push your repository to GitHub/GitLab.
2. Log in to [Render](https://render.com/) and go to **Blueprints**.
3. Connect your repository to Render.
4. Render will automatically read `render.yaml` and configure the service.
5. In the Render Dashboard, fill in the **Environment Variables**:
   - `GOOGLE_SHEET_ID`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `MONGODB_URI` (Essential to avoid data loss on restarts!)
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (Paste the *entire contents* of your `service-account.json` file as a single text string)
   - `CHECK_INTERVAL_CRON` (e.g., `0 * * * *` for hourly check)
   - `DASHBOARD_PORT` (Render uses `10000`)
6. Deploy the service.

### ⚠️ Keeping the Render Free Plan Awake
Render's **Free Plan** Web Services spin down (go to sleep) after **15 minutes of inactivity** (no inbound HTTP requests). When sleeping, the bot's background scheduler will *not* run.

To keep your bot active 24/7 for free:
1. Register for a free account on [UptimeRobot](https://uptimerobot.com/) or [Cron-Job.org](https://cron-job.org/).
2. Create a new **HTTPS / Web Monitor**.
3. Set the target URL to your Render Web Service's status endpoint: `https://your-app-name.onrender.com/api/status`.
4. Configure the check interval to **5 minutes** or **10 minutes**.
5. This regular ping keeps the service awake, ensuring background cron checks execute on time.

---

## 📡 API Endpoints

The Express server exposes the following JSON endpoints for integration or custom monitoring:

- **`GET /api/status`**
  - Returns the bot health, database connection status, the timestamp of the last successful sheet check, and total logged change events.
  - *Response Schema:*
    ```json
    {
      "status": "running",
      "lastCheck": "2026-06-11T14:30:21.000Z",
      "totalEventsLogged": 14,
      "dbStatus": { "connected": true, "type": "mongodb", "error": null }
    }
    ```
- **`GET /api/history`**
  - Retrieves the list of the last 500 checked events including their detailed row differences.
- **`GET /api/current-bookings`**
  - Retrieves the snapshot of all active bookings for the current month.
- **`GET /api/all-bookings`**
  - Retrieves the snapshot of all bookings currently present in the Google Sheet (excluding blank lines).

---

## 🔒 Security Guidelines

- **Credential Separation**: Never commit `.env` or your downloaded `service-account.json` key to your repository. They are ignored by default in `.gitignore`.
- **Minimal Scopes**: The service account only requires read permissions. Share the Google Sheet as **Viewer** rather than Editor to ensure maximum security.
- **Environment Variables**: For cloud hosts (like Render), prefer pasting the key contents directly into `GOOGLE_SERVICE_ACCOUNT_JSON` to avoid storing files on-disk.
