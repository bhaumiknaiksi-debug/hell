# HELL Stage 5 — rebuild notes (3 Nov 2026)

`npm test` → **55/55 pass** (38 Stage 4 + 11 Stage 5 + 6 market-feed). The broker in tests is a **simulator**: passing proves HELL's logic, not Upstox's real behaviour.

## Where each file came from
| File | Source |
|---|---|
| `paper_engine.js`, `server.js`, `upstox_client.js`, `upstox_live_layer.js`, `test.js` | Claude's 30 Oct Stage 4 rebuild (38/38), recovered word-for-word from that chat, then Stage 5 changes below. Your Gemini canvases of server.js and paper_engine.js match it. |
| `index.js` | Rewritten from Gemini's Stage 5 index.js (kept: Postgres pool, boot-before-listen, non-overlapping heartbeat). |
| `runner.js` | **New.** Gemini's original was never recovered. Storage adapter, feed failover, data-gap ledger, quote routing, instrument keys, signal path. |
| `engine.js` | **New, deliberately empty strategy.** Constants plus a "no signals" placeholder. See the gaps below. |

Not used: all 16 files Gemini regenerated on 3 Nov. They used MARKET exits, a lot size of 75, fake price data, a graduation bypass switch, and they flattened live positions on shutdown.

## Stage 5 changes
- **Unfilled chaser rule.** An exit starts at bid − ₹0.50. If it isn't fully filled after 3 s (`EXIT_ESCALATE_AFTER_MS`), it steps to bid − ₹2, then bid − ₹5, then ₹0.05, one step per second. A ₹0.05 sell takes any bid, so it fills at the best bid. No MARKET orders. Each step sends a Telegram alert with what has filled so far. If even ₹0.05 hasn't filled after 30 s, the order stays resting and every heartbeat keeps checking it.
- **Partial fills.** The rest of a part-filled exit keeps escalating. If the exchange cancels a part-filled exit, a new order is placed for the remaining quantity only. P&L is booked on the full lot at the real average exit price.
- **Real loss counts.** The daily cap, weekly cap and halts use the actual realised loss, even past the planned ₹653. The test drives one trade to about −₹2,020 and checks the day halts.
- **No overlapping heartbeats** (in server.js and index.js).
- **Instrument keys.** At boot, and each day from 08:45 IST, HELL downloads Upstox's NSE master and maps HELL symbols (`NIFTY26N0425000CE` weekly, `NIFTY26NOV25000CE` monthly) to Upstox keys. If the download fails, or the master's NIFTY lot size isn't 65, there are no keys: every live entry is blocked and you get a Telegram alert. HELL never guesses a key.
- **Shutdown** (SIGTERM/SIGINT): saves state, sends an alert, and exits. **It never touches orders**: an open position keeps its resting Upstox stop.
- **Startup refuses bad config**, for example missing variables, a WS_SECRET under 16 characters, a non-https redirect, or stops where trigger ≥ floor.
- **Tuesday (expiry) trades** are tagged `expiryDayTuesday: true` in paper and live trade records.
- **planVersionId**: chaser timing is *not* part of it. Changing the 3 s timing doesn't restart graduation; changing the stops does.

## What HELL still cannot do (so it won't trade yet)
1. **No strategy.** The 5-minute breakout logic from the Gemini "Pieces 1–4" chats isn't here. `engine.js` produces no signals until the real strategy is added (its interface is documented at the top of the file).
2. ~~No live market-data feed~~ **Added 4 Nov:** `upstox_feed.js` (see "Live market data" below). It has only been tested against a local fake of Upstox's feed, not the real one.
3. Static-IP host (not Render free tier), HTTPS for the Upstox redirect, and the Telegram webhook still need setting up.

## Not verified against real Upstox (check on the supervised 1-lot test)
- Whether Upstox lets an SL order be modified into a LIMIT. If not, HELL cancels, confirms the cancel, then places a new exit (tested), which leaves a short window with no stop.
- Whether a ₹0.05 sell is accepted, or rejected by exchange price-protection bands. If rejected, HELL re-places it and alerts, but the "always flat" promise then depends on manual action.
- Field names in the Upstox instrument master (`segment`, `name`, `instrument_type`, `strike_price`, `expiry`, `lot_size`). On the first boot, check the log line `N NIFTY instrument keys loaded`.
- Status strings, `filled_quantity`/`average_price`, the funds field, the tag length limit, and the `X-Algo-Name` header.

## Deploy check (done here)
I booted `index.js` against a real PostgreSQL 16. It created its tables, `/health` returned 200, and SIGTERM saved state and exited with code 0. A missing config makes it exit 1 with the list of problems.

## Live market data (`upstox_feed.js`, added 4 Nov 2026)
- Uses Upstox Market Data Feed V3 over a WebSocket with protobuf messages. The schema is vendored in `proto/` from Upstox's own Node SDK (MIT licence).
- Connects automatically once `/login` has produced today's Upstox token. There is nothing extra to configure.
- Subscribes to the NIFTY 50 index. On the first price, it also subscribes the **nearest-expiry** NIFTY options within ±10 strikes (42 contracts, CE and PE). If spot moves 100 points it widens the window. It never unsubscribes during the day, so an open position always keeps its quotes.
- An option quote is passed on only with a real best bid **and** ask, taken from the depth. That is what the paper stops and live exits are priced from.
- If the socket drops, it reconnects with backoff (1 s, 2 s, 5 s, 10 s, 30 s) and resubscribes everything. A socket that goes silent for 30 s in market hours is dropped and reconnected. While there's no data, the runner opens a data gap: entries are blocked and that day doesn't count toward graduation.
- Contract IDs come from the daily instrument master, so the feed and the order layer use the same keys.

**Check on the first market morning (log lines `HELL feed:`):** "connected (1 instruments)", then index prices flowing, then about 43 subscriptions, then `/health` showing `activeSource: "UPSTOX"`. If the connect fails with HTTP 401/403, the token or app permissions are the problem. Exact endpoint behaviour, the auth header and the message format are from the SDK and have not been tried against the real feed (this sandbox can't reach api.upstox.com).
