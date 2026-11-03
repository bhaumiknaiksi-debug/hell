'use strict';

// Live NIFTY market data from the Upstox Market Data Feed V3 (WebSocket,
// protobuf messages). Plugs into runner.js as a feed:
//   { name, onTick(handler), start(), stop() }
//
// What it does:
//  - Connects once an Upstox access token exists (after /login), with the token
//    as a Bearer header, the same way Upstox's own Node SDK connects.
//  - Subscribes to the NIFTY 50 index. When the first index price arrives it also
//    subscribes the nearest-expiry NIFTY options within ±STRIKE_WINDOW strikes of
//    spot (CE and PE), and widens that window if spot moves. It never unsubscribes
//    during the day, so an open position's contract always keeps its quotes.
//  - Turns each message into runner ticks: { kind: 'spot', ltp, ts } for the index,
//    { kind: 'option', sym, instrumentKey, ltp, b, a, ts } for options (best bid/ask
//    from the depth). Option ticks without a two-sided quote are dropped.
//  - Reconnects with backoff, and drops a silent connection after STALE_MS during
//    market hours, so the runner's data-gap ledger sees real outages.
//
// UNVERIFIED against a live Upstox connection: the endpoint, header auth, the
// subscribe message and the protobuf schema come from upstox-js-sdk 2.31.0.

const path = require('path');
const crypto = require('crypto');
const protobuf = require('protobufjs');

const DEFAULT_URL = 'wss://api.upstox.com/v3/feed/market-data-feed';
const NIFTY_INDEX_KEY = 'NSE_INDEX|Nifty 50';
const STRIKE_STEP = 50;
const STRIKE_WINDOW = 10;           // ±10 strikes = 21 strikes x CE/PE = 42 contracts
const RECENTRE_AFTER_PTS = 100;     // widen the window once spot has moved this far
const STALE_MS = 30000;             // no message for 30 s in market hours -> reconnect
const WATCH_MS = 5000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

let FeedResponse = null;
function feedResponseType() {
    if (!FeedResponse) {
        const root = protobuf.loadSync(path.join(__dirname, 'proto', 'MarketDataFeedV3.proto'));
        FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
    }
    return FeedResponse;
}

function decodeFeedResponse(buf) {
    const T = feedResponseType();
    return T.toObject(T.decode(buf), { longs: Number, enums: String, defaults: false, oneofs: true });
}

// Test helper: build a binary frame the way Upstox would.
function encodeFeedResponse(obj) {
    const T = feedResponseType();
    return Buffer.from(T.encode(T.fromObject(obj)).finish());
}

function istMarketHours(ms) {
    const d = new Date(ms + 19800000);
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    const wd = d.getUTCDay();
    return wd >= 1 && wd <= 5 && m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

// Feed -> { ltp, ts, bid, ask } (bid/ask only when depth is present).
function readFeed(feed, fallbackTs) {
    if (!feed) return null;
    let ltpc = null, quote = null;
    if (feed.ltpc) ltpc = feed.ltpc;
    else if (feed.fullFeed && feed.fullFeed.marketFF) {
        ltpc = feed.fullFeed.marketFF.ltpc;
        const lv = feed.fullFeed.marketFF.marketLevel;
        quote = lv && Array.isArray(lv.bidAskQuote) ? lv.bidAskQuote[0] : null;
    } else if (feed.fullFeed && feed.fullFeed.indexFF) ltpc = feed.fullFeed.indexFF.ltpc;
    else if (feed.firstLevelWithGreeks) { ltpc = feed.firstLevelWithGreeks.ltpc; quote = feed.firstLevelWithGreeks.firstDepth; }
    if (!ltpc) return null;
    const ts = Number(ltpc.ltt) > 0 ? Number(ltpc.ltt) : fallbackTs;
    return {
        ltp: Number(ltpc.ltp) || null, ts,
        bid: quote && Number(quote.bidP) > 0 ? Number(quote.bidP) : null,
        ask: quote && Number(quote.askP) > 0 ? Number(quote.askP) : null
    };
}

function createUpstoxMarketFeed({
    name = 'UPSTOX',
    getAccessToken,                       // () => token | null
    getContracts = () => [],              // () => [{ symbol, instrumentKey, strike, type, expiryMs }]
    url = process.env.UPSTOX_FEED_URL || DEFAULT_URL,
    WebSocketImpl = require('ws'),
    getTime = () => Date.now(),
    onStatus = () => {},                  // (text) => void, for logs/alerts
    watchMs = WATCH_MS
} = {}) {
    if (typeof getAccessToken !== 'function') throw new Error('getAccessToken is required');
    const handlers = [];
    const subscribed = new Set();         // instrument keys subscribed on the current connection
    const wanted = new Set([NIFTY_INDEX_KEY]);
    const keyToSymbol = Object.create(null);
    let ws = null, timer = null, stopped = true, attempt = 0, nextTryMs = 0;
    let lastMsgMs = 0, centre = null, dayKey = null, connecting = false;
    const stats = { connects: 0, messages: 0, decodeErrors: 0, lastError: null };

    const isOpen = () => ws && ws.readyState === 1;
    const emit = async (tick) => { for (const h of handlers) await h(tick); };

    function send(keys) {
        if (!isOpen() || keys.length === 0) return;
        for (let i = 0; i < keys.length; i += 100) {
            const chunk = keys.slice(i, i + 100);
            ws.send(Buffer.from(JSON.stringify({ guid: crypto.randomUUID(), method: 'sub', data: { mode: 'full', instrumentKeys: chunk } })));
            chunk.forEach(k => subscribed.add(k));
        }
    }
    function syncSubscriptions() { send([...wanted].filter(k => !subscribed.has(k))); }

    // Nearest-expiry options around spot.
    function widenWindow(spot) {
        const nowMs = getTime();
        const todayStart = nowMs - ((nowMs + 19800000) % 86400000);
        const contracts = (getContracts() || []).filter(c => c && c.instrumentKey && Number(c.expiryMs) >= todayStart);
        if (!contracts.length) return;
        const nearest = Math.min(...contracts.map(c => Number(c.expiryMs)));
        const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
        for (const c of contracts) {
            if (Number(c.expiryMs) !== nearest) continue;
            if (Math.abs(Number(c.strike) - atm) > STRIKE_WINDOW * STRIKE_STEP) continue;
            keyToSymbol[c.instrumentKey] = c.symbol;
            wanted.add(c.instrumentKey);
        }
        centre = spot;
        syncSubscriptions();
    }

    async function onMessage(data) {
        lastMsgMs = getTime();
        stats.messages++;
        let msg;
        try { msg = decodeFeedResponse(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch (err) {
            stats.decodeErrors++; stats.lastError = `decode: ${err.message}`; return;
        }
        if (!msg.feeds) return;
        const fallbackTs = Number(msg.currentTs) > 0 ? Number(msg.currentTs) : getTime();
        for (const [key, feed] of Object.entries(msg.feeds)) {
            const f = readFeed(feed, fallbackTs);
            if (!f || !f.ltp) continue;
            if (key === NIFTY_INDEX_KEY) {
                if (centre === null || Math.abs(f.ltp - centre) >= RECENTRE_AFTER_PTS) widenWindow(f.ltp);
                await emit({ kind: 'spot', ltp: f.ltp, ts: f.ts, src: name });
            } else if (keyToSymbol[key] && f.bid && f.ask) {
                await emit({ kind: 'option', sym: keyToSymbol[key], instrumentKey: key, ltp: f.ltp, b: f.bid, a: f.ask, ts: f.ts, src: name });
            }
        }
    }

    function connect() {
        const token = getAccessToken();
        if (!token || connecting || isOpen()) return;
        connecting = true;
        subscribed.clear();
        let sock;
        try {
            sock = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: '*/*' }, followRedirects: true });
        } catch (err) { connecting = false; scheduleRetry(`connect: ${err.message}`); return; }
        ws = sock;
        sock.on('open', () => {
            connecting = false; attempt = 0; stats.connects++; lastMsgMs = getTime();
            onStatus(`Upstox market feed connected (${wanted.size} instruments).`);
            syncSubscriptions();
        });
        sock.on('message', (d) => { onMessage(d).catch((e) => { stats.lastError = e.message; }); });
        sock.on('unexpected-response', (req, res) => {
            stats.lastError = `HTTP ${res.statusCode} on connect`;
            try { sock.terminate(); } catch (_) {}
        });
        sock.on('error', (err) => { stats.lastError = err.message; });
        sock.on('close', (code) => {
            connecting = false;
            if (ws === sock) ws = null;
            if (!stopped) scheduleRetry(`closed (${code})${stats.lastError ? `: ${stats.lastError}` : ''}`);
        });
    }

    function scheduleRetry(reason) {
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt++;
        nextTryMs = getTime() + wait;
        onStatus(`Upstox market feed down: ${reason}. Retrying in ${Math.round(wait / 1000)} s.`);
    }

    function watch() {
        const now = getTime();
        const dk = new Date(now + 19800000).toISOString().slice(0, 10);
        if (dk !== dayKey) {            // new day: drop yesterday's contracts, recentre on first price
            dayKey = dk; centre = null;
            for (const k of [...wanted]) if (k !== NIFTY_INDEX_KEY) wanted.delete(k);
            if (ws) { try { ws.close(4000, 'new day'); } catch (_) {} }
        }
        if (isOpen() && istMarketHours(now) && now - lastMsgMs > STALE_MS) {
            stats.lastError = `no data for ${Math.round((now - lastMsgMs) / 1000)} s`;
            try { ws.terminate(); } catch (_) {}
            return;
        }
        if (!isOpen() && !connecting && now >= nextTryMs) connect();
    }

    return {
        name,
        onTick(fn) { handlers.push(fn); },
        async start() {
            if (!stopped) return;
            stopped = false;
            watch();
            timer = setInterval(watch, watchMs);
            if (timer.unref) timer.unref();
        },
        async stop() {
            stopped = true;
            if (timer) clearInterval(timer);
            timer = null;
            if (ws) { try { ws.close(1000); } catch (_) {} }
        },
        isConnected: isOpen,
        getStats: () => ({ ...stats, subscribed: subscribed.size, wanted: wanted.size, centre }),
        _watch: watch
    };
}

module.exports = { createUpstoxMarketFeed, decodeFeedResponse, encodeFeedResponse, readFeed, NIFTY_INDEX_KEY, STRIKE_WINDOW };
