# HELL Stage 4 — rebuild notes (30 Oct 2026)

Built on the round-1 files (the last version that worked). `node test.js` → 38/38 pass (output in `test_output.txt`).
The key safety tests were mutation-checked: putting back "cancel SL before exit", "no fill re-read after cancel" or "risk state not saved" makes them fail.

## Files
| File | What it is |
|---|---|
| `paper_engine.js` | Risk governor + paper engine. Stops are config, state is persisted, feed verification is earned, graduation is tied to the stop config. |
| `upstox_client.js` | **Real** Upstox HTTP client (v3 place/modify/cancel on api-hft, v2 reads, OAuth). |
| `upstox_live_layer.js` | Live order manager: fills from order status, SL on every fill, exits never cancel the SL first, boot recovery, reconcile. |
| `server.js` | Round-1 server (Telegram retries, WebSocket, /health, lockout all kept) with live wiring, OAuth login, Telegram commands, persistence. |
| `test.js` | 38 tests. The broker in tests is a **simulator**, clearly labelled. |

## Your decision (still open)
With default stops (8 / 10 / 14 below entry) and a ₹600 daily cap, every ATM entry is blocked (test 1 proves it). Pick one:
- **Tighter stops:** set `STOP_TRIGGER_OFFSET_RS`, `STOP_LIMIT_FLOOR_OFFSET_RS` and `STOP_CHASER_MAX_SLIPPAGE_RS` (e.g. 5 / 6 / 7 fits ₹600).
- **Bigger cap:** raise `DAILY_LOSS_CAP_RS` (and `MAX_WEEKLY_LOSS_RS`).
Changing stops changes the plan version, so graduation restarts on the new stops.

## Things that must exist outside these files
1. **Storage adapter:** add `saveKv(key, jsonString)` and `loadKv(key)` (one table: key text primary key, value text, updated_at). Without them HELL blocks every entry on purpose.
2. **runner.js:** must call `onOptionQuote({ symbol, bid, ask })` for the open contract, and put the Upstox `instrumentKey` (e.g. `NSE_FO|43919`) in `signal.contract`. I haven't seen runner.js, so check this.
3. **Heartbeat:** something must call `server.stepTime()` about every 1–5 seconds, from before 09:20 to after 15:30.
4. **Host:** a static-IP server that doesn't sleep (the Droplet), with HTTPS for the Upstox redirect.

## Environment variables (new)
`UPSTOX_CLIENT_ID`, `UPSTOX_CLIENT_SECRET`, `UPSTOX_REDIRECT_URI` (https://your-host/upstox/callback), `UPSTOX_ALGO_NAME` (exact name from Upstox My Apps), `EXPECTED_STATIC_IP`, `TELEGRAM_WEBHOOK_SECRET`, plus the stop and limit settings above. `TOTAL_CAPITAL_RS` is used for paper only; live entries are sized from real Upstox funds.

## Daily flow (Telegram)
`/login` → tap link → Upstox login (also reconciles) → `/paper` or `/confirm-live` then `/live` → `/status` any time → `/kill` (latches; clear with `POST /admin/clear-kill`) or `/flatten` (exit without latching).

## NOT verified against real Upstox (check on the supervised 1-lot test)
- Whether Upstox lets you **modify an SL order into a LIMIT**. If it refuses, HELL falls back to cancel → confirm → new exit (tested), which leaves a short window with no resting stop.
- Exact status strings, `filled_quantity` and `average_price` behaviour, the funds field (`equity.available_margin`), the positions field names and the tag length limit.
- Static-IP enforcement and the `X-Algo-Name` header against your registered app.
