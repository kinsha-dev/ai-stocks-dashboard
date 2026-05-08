/**
 * TradingView Webhook → Push Notification Server
 *
 * Receives TradingView SPX signal webhooks and sends
 * instant push notifications to your phone via ntfy.sh (free).
 *
 * Setup:
 *   1. npm install
 *   2. Install "ntfy" app on your phone (iOS / Android)
 *   3. Subscribe to your topic in the app (e.g. "spx-signals-kinsha")
 *   4. Copy .env.example → .env and fill in NTFY_TOPIC
 *   5. node webhook_monitor.js
 *
 * TradingView Alert Webhook URL:
 *   http://<your-server-ip>:3001/webhook
 */

"use strict";

const http    = require("http");
const https   = require("https");
const url     = require("url");
const fs      = require("fs");
const path    = require("path");

// ── CONFIG (from env or defaults) ─────────────────────────
const PORT         = process.env.PORT         || 3001;
const NTFY_TOPIC   = process.env.NTFY_TOPIC   || "spx-signals-kinsha";   // change this
const NTFY_SERVER  = process.env.NTFY_SERVER  || "https://ntfy.sh";
const NTFY_TOKEN   = process.env.NTFY_TOKEN   || "";   // optional, for private topics
const SECRET       = process.env.WEBHOOK_SECRET || "";  // optional security token
const LOG_FILE     = process.env.LOG_FILE     || path.join(__dirname, "signals.log");
const ALERT_ON     = (process.env.ALERT_ON    || "BUY,SELL,STRONG_BUY,STRONG_SELL")
                       .split(",").map(s => s.trim().toUpperCase());

// ── LOGGER ────────────────────────────────────────────────
function log(level, msg, data = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── PUSH NOTIFICATION via ntfy.sh ─────────────────────────
function emoji(action) {
    const map = { BUY: "🟢", SELL: "🔴", STRONG_BUY: "🚀", STRONG_SELL: "⚠️" };
    return map[action] || "📊";
}

function priority(action) {
    // ntfy priorities: min=1, low=2, default=3, high=4, urgent=5
    if (action === "STRONG_BUY" || action === "STRONG_SELL") return "5";
    if (action === "BUY" || action === "SELL") return "4";
    return "3";
}

function sendPush(signal) {
    const action = (signal.action || "").toUpperCase();
    const price  = parseFloat(signal.price || 0).toLocaleString("en-US", { minimumFractionDigits: 2 });
    const rsi    = signal.rsi   ? parseFloat(signal.rsi).toFixed(1) : "-";
    const score  = signal.score ? signal.score : "-";
    const time   = signal.time  ? new Date(signal.time).toLocaleTimeString() : new Date().toLocaleTimeString();

    // Use JSON body — supports emojis and full UTF-8 in all fields
    const payload = JSON.stringify({
        topic:    NTFY_TOPIC,
        title:    `${emoji(action)} SPX ${action.replace(/_/g, " ")}`,
        message:  `Price: $${price} | RSI: ${rsi} | Score: ${score}/3 | ${time}`,
        priority: parseInt(priority(action), 10),
        tags:     [action === "BUY" || action === "STRONG_BUY" ? "chart_increasing" : "chart_decreasing"],
    });

    const ntfyUrl  = url.parse(NTFY_SERVER);
    const transport = ntfyUrl.protocol === "https:" ? https : http;

    const headers = {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
    };
    if (NTFY_TOKEN) headers["Authorization"] = `Bearer ${NTFY_TOKEN}`;

    const options = {
        hostname: ntfyUrl.hostname,
        port:     ntfyUrl.port || (ntfyUrl.protocol === "https:" ? 443 : 80),
        path:     "/",
        method:   "POST",
        headers,
    };

    return new Promise((resolve, reject) => {
        const req = transport.request(options, (res) => {
            let body = "";
            res.on("data", chunk => body += chunk);
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    log("INFO", "Push sent OK", { action, price, status: res.statusCode });
                    resolve(body);
                } else {
                    log("ERROR", "Push failed", { status: res.statusCode, body });
                    reject(new Error(`ntfy returned ${res.statusCode}: ${body}`));
                }
            });
        });
        req.on("error", (err) => {
            log("ERROR", "Push request error", { error: err.message });
            reject(err);
        });
        req.write(payload);
        req.end();
    });
}

// ── PARSE BODY ────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", chunk => raw += chunk);
        req.on("end", () => {
            try {
                resolve(typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : {});
            } catch (e) {
                reject(new Error("Invalid JSON: " + raw));
            }
        });
    });
}

// ── HTTP SERVER ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    // Health check
    if (req.method === "GET" && parsedUrl.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", topic: NTFY_TOPIC, ts: new Date().toISOString() }));
        return;
    }

    // Webhook endpoint
    if (req.method === "POST" && parsedUrl.pathname === "/webhook") {

        // 1. Optional secret check
        if (SECRET && parsedUrl.query.secret !== SECRET) {
            log("WARN", "Invalid secret", { ip: req.socket.remoteAddress });
            res.writeHead(401);
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
        }

        // 2. Parse body
        let signal;
        try {
            signal = await parseBody(req);
        } catch (e) {
            log("ERROR", "Parse error", { error: e.message });
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Bad JSON" }));
            return;
        }

        log("INFO", "Signal received", { signal });

        // 3. Respond immediately (TradingView expects < 3s)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", action: signal.action, ts: new Date().toISOString() }));

        // 4. Filter and notify
        const action = (signal.action || "").toUpperCase();
        if (!ALERT_ON.includes(action)) {
            log("INFO", "Signal filtered", { action, ALERT_ON });
            return;
        }

        sendPush(signal).catch(err => log("ERROR", "Push failed", { error: err.message }));
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
    log("INFO", "Webhook server started", {
        port:      PORT,
        ntfy:      `${NTFY_SERVER}/${NTFY_TOPIC}`,
        alertOn:   ALERT_ON,
        webhookUrl:`http://0.0.0.0:${PORT}/webhook`,
    });
    console.log(`\n  Webhook URL: http://YOUR_IP:${PORT}/webhook`);
    console.log(`  ntfy topic:  ${NTFY_SERVER}/${NTFY_TOPIC}`);
    console.log(`  Health:      http://localhost:${PORT}/health\n`);
});
