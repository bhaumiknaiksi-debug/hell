'use strict';

// HELL runner: storage adapter, market-data feeds with failover, data-gap
// ledger, option-quote routing, Upstox instrument keys and the signal path.
//
// Feeds are objects with { name, onTick(handler), start?(), stop?() }.
// createSimulatedFeed() is the test/dev feed. A live Upstox/Fyers market-data
// feed is NOT included yet: with no live feed, the active source is 'UNKNOWN'
// and the risk governor blocks every entry (fail closed).

const engine = require('./engine.js');

const FEED_STALE_MS = 10000;        // a feed with no tick for 10 s is not usable
const QUOTE_MAX_AGE_MS = 5000;      // an option quote older than 5 s is not VERIFIED
const IST_OFFSET_MS = 19800000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

function istMinutes(ms) {
    const d = new Date(ms + IST_OFFSET_MS);
    return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}
function inMarketHours(ms) {
    const { minutes, weekday } = istMinutes(ms);
    return weekday >= 1 && weekday <= 5 && minutes >= MARKET_OPEN_MIN && minutes < MARKET_CLOSE_MIN;
}

// ----------------------------------------------------------------- storage
// One table for durable state (edge_kv) and one for the decision audit trail.
// Every function throws on a database error, so callers fail closed.
function createPgStorageAdapter(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('createPgStorageAdapter needs a pg Pool');
    let auditFailed = false;

    return {
        async initSchema() {
            await pool.query(`CREATE TABLE IF NOT EXISTS edge_kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at BIGINT NOT NULL
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS edge_decision_audit (
                id BIGSERIAL PRIMARY KEY,
                ts BIGINT NOT NULL,
                category TEXT NOT NULL,
                action TEXT NOT NULL,
                reason TEXT,
                metadata JSONB
            )`);
        },
        async saveKv(key, value) {
            await pool.query(
                `INSERT INTO edge_kv (key, value, updated_at) VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                [key, String(value), Date.now()]
            );
        },
        async loadKv(key) {
            const r = await pool.query('SELECT value FROM edge_kv WHERE key = $1', [key]);
            return r.rows && r.rows.length ? r.rows[0].value : null;
        },
        async appendDecisionAudit(rec) {
            try {
                await pool.query(
                    'INSERT INTO edge_decision_audit (ts, category, action, reason, metadata) VALUES ($1, $2, $3, $4, $5)',
                    [rec.ts, rec.category, rec.action, rec.reason, JSON.stringify(rec.metadata || {})]
                );
                auditFailed = false;
            } catch (err) {
                auditFailed = true;   // audit trail incomplete -> runner reports persistence failure -> no new entries
                throw err;
            }
        },
        isAuditFailing: () => auditFailed
    };
}

// ----------------------------------------------------------------- feeds
function createSimulatedFeed(name) {
    const handlers = [];
    return {
        name,
        onTick(fn) { handlers.push(fn); },
        async emitRawTick(raw) { for (const h of handlers) await h({ src: name, ...raw }); }
    };
}

// Normalises a raw tick. Option ticks: { kind: 'option', sym, ts, ltp, b, a, src, instrumentKey? }
// Spot ticks: { kind: 'spot', ltp, ts, src }
function normaliseTick(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ts = Number(raw.ts);
    if (!Number.isFinite(ts)) return null;
    const kind = raw.kind === 'option' ? 'option' : (raw.kind === 'spot' || raw.kind === 'index' ? 'spot' : null);
    if (!kind) return null;
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    if (kind === 'spot') {
        const ltp = num(raw.ltp);
        return ltp ? { kind, ltp, ts, source: raw.src || null } : null;
    }
    const symbol = raw.sym || raw.symbol;
    if (!symbol) return null;
    return {
        kind, symbol: String(symbol), ts, ltp: num(raw.ltp), bid: num(raw.b ?? raw.bid), ask: num(raw.a ?? raw.ask),
        source: raw.src || null, instrumentKey: raw.instrumentKey || raw.instrument_key || null
    };
}

// ----------------------------------------------------------------- runner
function createRunner({
    getTime = () => Date.now(),
    storageAdapter = null,
    feeds = [],
    config = {},
    strategy = null,
    onSignal = async () => {},
    onOptionQuote = async () => {},
    onWarning = async () => {}
} = {}) {
    const strat = strategy || engine.createNoSignalStrategy();
    const feedNames = feeds.map(f => f.name);
    const lastTickMs = Object.create(null);
    const openGaps = Object.create(null);
    const gapHistory = [];
    const quotes = Object.create(null);
    const instrumentKeys = Object.assign(Object.create(null), config.instrumentKeys || {});
    const keyResolver = typeof config.instrumentKeyResolver === 'function' ? config.instrumentKeyResolver : null;
    let lastSource = 'UNKNOWN';

    function activeSource(nowMs = getTime()) {
        for (const name of feedNames) {
            if (lastTickMs[name] && nowMs - lastTickMs[name] <= FEED_STALE_MS) return name;
        }
        return 'UNKNOWN';
    }

    const failoverManager = { getSource: () => activeSource(), getFeedNames: () => [...feedNames] };
    const gapLedger = { getOpenGaps: () => ({ ...openGaps }), getHistory: () => [...gapHistory] };

    function resolveInstrumentKey(symbol) {
        if (!symbol) return null;
        if (instrumentKeys[symbol]) return instrumentKeys[symbol];
        if (keyResolver) {
            try { const k = keyResolver(symbol); if (k) { instrumentKeys[symbol] = k; return k; } } catch (_) { return null; }
        }
        return null;
    }
    function registerInstrumentKey(symbol, key) { if (symbol && key) instrumentKeys[symbol] = String(key); }

    async function warn(type, reason) { try { await onWarning({ type, reason }); } catch (_) {} }

    async function handleTick(raw) {
        const t = normaliseTick(raw);
        if (!t) return;
        if (t.source) lastTickMs[t.source] = Math.max(lastTickMs[t.source] || 0, getTime());
        const src = activeSource();
        if (src !== lastSource) {
            if (lastSource !== 'UNKNOWN' && src !== 'UNKNOWN') await warn('FEED_FAILOVER', `${lastSource} -> ${src}`);
            lastSource = src;
        }
        if (t.source && src !== 'UNKNOWN' && t.source !== src) return;   // only the active feed drives HELL

        if (t.kind === 'option') {
            if (t.instrumentKey) registerInstrumentKey(t.symbol, t.instrumentKey);
            const quote = { symbol: t.symbol, bid: t.bid, ask: t.ask, ltp: t.ltp, ts: t.ts, feed_source: t.source, receivedAtMs: getTime() };
            quotes[t.symbol] = quote;
            try { if (typeof strat.onOptionQuote === 'function') strat.onOptionQuote(quote); } catch (_) {}
            await onOptionQuote(quote);
            return;
        }
        let drafts = [];
        try { drafts = strat.onSpotTick({ ltp: t.ltp, ts: t.ts, source: t.source }) || []; } catch (err) {
            await warn('STRATEGY_ERROR', String(err && err.message));
        }
        for (const d of drafts) await emitSignal(d);
    }

    // Completes a strategy draft with quote + instrument key, then hands it to the server.
    async function emitSignal(draft) {
        if (!draft || !draft.signalId || !draft.contract || !draft.contract.symbol) return;
        const symbol = draft.contract.symbol;
        const q = quotes[symbol];
        const fresh = q && getTime() - q.receivedAtMs <= QUOTE_MAX_AGE_MS && q.bid && q.ask && q.ask >= q.bid;
        const instrumentKey = resolveInstrumentKey(symbol);
        if (!instrumentKey) await warn('INSTRUMENT_KEY_UNRESOLVED', `No Upstox key for ${symbol}; no order will be placed.`);
        const sig = {
            ...draft,
            contract: { ...draft.contract, instrumentKey },
            quote: q ? { bid: q.bid, ask: q.ask, ltp: q.ltp } : null,
            quoteStatus: fresh ? 'VERIFIED' : 'UNVERIFIED',
            feedSource: activeSource()
        };
        await onSignal(sig);
    }

    async function boot() {
        for (const f of feeds) {
            if (typeof f.onTick === 'function') f.onTick(handleTick);
            if (typeof f.start === 'function') await f.start();
        }
        if (feeds.length === 0) await warn('NO_MARKET_DATA_FEED', 'No market-data feed configured: HELL will not take any entries.');
    }

    // Called on every heartbeat: opens/closes data gaps for the active feed.
    async function stepTime(nowMs = getTime()) {
        if (!inMarketHours(nowMs) || feeds.length === 0) return;
        const src = activeSource(nowMs);
        const stale = src === 'UNKNOWN';
        if (stale && !openGaps.FEED) {
            openGaps.FEED = { since: nowMs };
            gapHistory.push({ openedAtMs: nowMs, closedAtMs: null });
            await warn('DATA_GAP', 'No fresh market data from any feed. New entries blocked.');
        } else if (!stale && openGaps.FEED) {
            delete openGaps.FEED;
            const g = gapHistory[gapHistory.length - 1]; if (g) g.closedAtMs = nowMs;
            await warn('DATA_RECOVERED', `Feed ${src} is live again.`);
        }
    }

    return {
        boot, stepTime, emitSignal, handleTick,
        getGapLedger: () => gapLedger,
        getFailoverManager: () => failoverManager,
        getPersistenceHealth: () => ({ currentlyFailed: Boolean(storageAdapter && typeof storageAdapter.isAuditFailing === 'function' && storageAdapter.isAuditFailing()) }),
        resolveInstrumentKey, registerInstrumentKey,
        getLatestQuote: (sym) => (quotes[sym] ? { ...quotes[sym] } : null),
        getStrategyName: () => strat.name
    };
}

module.exports = { createPgStorageAdapter, createSimulatedFeed, createRunner, normaliseTick, inMarketHours, FEED_STALE_MS, QUOTE_MAX_AGE_MS };
