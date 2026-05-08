/**
 * start.js — launches both services together:
 *   1. Webhook server  (port 3001) — receives TradingView alerts
 *   2. Signal checker  — polls Yahoo Finance every 5 min, detects signals independently
 *
 * Usage: node start.js
 */
"use strict";

console.log("=== SPX Signal Monitor ===\n");
require("./webhook_monitor.js");
require("./signal_checker.js");
