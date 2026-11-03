'use strict';

// HELL production entrypoint: `npm start`.
// Order of boot: config check -> Postgres -> instrument master -> server boot
// (restores state, always SHADOW) -> HTTP listen -> 2 s heartbeat.

const zlib = require('zlib');
const serverMod = require('./server.js');
const runnerMod = require('./runner.js');
const paperMod = require('./paper_engine.js');

const PORT = Number(process.env.PORT) || 3000;
const HEARTBEAT_INTERVAL_MS = 2000;
const INSTRUMENT_MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const MASTER_REFRESH_AFTER_MIN_IST = 8 * 60 + 45;   // reload each trading day from 08:45 IST

const REQUIRED_ENV = [
    'DATABASE_URL', 'WS_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET',
    'EXPECTED_STATIC_IP', 'UPSTOX_CLIENT_ID', 'UPSTOX_CLIENT_SECRET', 'UPSTOX_REDIRECT_URI', 'UPSTOX_ALGO_NAME'
];

function checkConfig(env) {
    const missing = REQUIRED_ENV.filter(k => !env[k] || !String(env[k]).trim());
    const problems = missing.map(k => `missing ${k}`);
    if (env.WS_SECRET && String(env.WS_SECRET).length < 16) problems.push('WS_SECRET must be at least 16 characters');
    if (env.UPSTOX_REDIRECT_URI && !/^https:\/\//.test(env.UPSTOX_REDIRECT_URI)) problems.push('UPSTOX_REDIRECT_URI must start with https://');
    try {
        paperMod.resolvePlanConfig({
            stopTriggerOffsetRs: env.STOP_TRIGGER_OFFSET_RS, stopLimitFloorOffsetRs: env.STOP_LIMIT_FLOOR_OFFSET_RS,
            stopChaserMaxSlippageRs: env.STOP_CHASER_MAX_SLIPPAGE_RS, targetOffsetRs: env.TARGET_OFFSET_RS
        });
    } catch (err) { problems.push(err.message); }
    return problems;
}

// ----------------------------------------------------------- instrument master
const MONTH3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKLY_MONTH = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D'];

function istDateParts(ms) {
    const d = new Date(Number(ms) + 19800000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

// HELL's symbol format (NSE style): weekly NIFTY26N0425000CE, monthly NIFTY26NOV25000CE.
function hellSymbol({ y, m, d }, strike, type, isMonthly) {
    const yy = String(y % 100).padStart(2, '0');
    const exp = isMonthly ? MONTH3[m] : `${WEEKLY_MONTH[m]}${String(d).padStart(2, '0')}`;
    return `NIFTY${yy}${exp}${Math.round(strike)}${type}`;
}

// Builds { symbol -> instrument_key } for NIFTY options from the Upstox NSE master.
// Field names follow Upstox's BOD JSON (segment, name, instrument_type, strike_price,
// expiry in epoch ms, lot_size, trading_symbol, instrument_key). UNVERIFIED against a
// live download: check the boot log line "instrument keys loaded" on the first run.
function buildNiftyKeyMap(list, expectedLotSize = paperMod.LOT_SIZE) {
    const opts = (Array.isArray(list) ? list : []).filter(i => i && i.segment === 'NSE_FO'
        && String(i.name || i.underlying_symbol || '').toUpperCase() === 'NIFTY'
        && (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.instrument_key && i.expiry);
    const lastExpiryInMonth = Object.create(null);
    for (const i of opts) {
        const p = istDateParts(i.expiry); const k = `${p.y}-${p.m}`;
        if (!lastExpiryInMonth[k] || p.d > lastExpiryInMonth[k]) lastExpiryInMonth[k] = p.d;
    }
    const map = Object.create(null);
    const lotSizes = new Set();
    for (const i of opts) {
        const p = istDateParts(i.expiry);
        const monthly = lastExpiryInMonth[`${p.y}-${p.m}`] === p.d;
        map[hellSymbol(p, Number(i.strike_price), i.instrument_type, monthly)] = String(i.instrument_key);
        if (i.trading_symbol) map[String(i.trading_symbol).trim()] = String(i.instrument_key);
        if (i.lot_size) lotSizes.add(Number(i.lot_size));
    }
    if (opts.length && (lotSizes.size !== 1 || !lotSizes.has(expectedLotSize))) {
        throw new Error(`NIFTY lot size in Upstox master is ${[...lotSizes].join('/')} but HELL is built for ${expectedLotSize}. Refusing to trade.`);
    }
    return { map, count: opts.length };
}

async function fetchUpstoxInstrumentMaster(fetchFn = globalThis.fetch, url = process.env.UPSTOX_INSTRUMENT_MASTER_URL || INSTRUMENT_MASTER_URL) {
    let res;
    try { res = await fetchFn(url); } catch (err) { throw new Error(`Failed to download Upstox instrument master: ${err.message}`); }
    if (!res || !res.ok) throw new Error(`Failed to download Upstox instrument master: HTTP ${res && res.status}`);
    let data;
    if (typeof res.arrayBuffer === 'function' && /\.gz($|\?)/.test(url)) {
        const buf = Buffer.from(await res.arrayBuffer());
        data = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    } else {
        data = await res.json();
    }
    const { map, count } = buildNiftyKeyMap(Array.isArray(data) ? data : (data && data.data) || []);
    if (count === 0) throw new Error('Upstox instrument master contained no NIFTY options');
    return map;
}

// ----------------------------------------------------------- shutdown
// Never touches orders: a resting broker SL keeps protecting any open position.
async function shutdownGracefully({ edgeServer, pool = null, signal = 'SIGTERM', stopHeartbeat = () => {}, telegramWaitMs = 8000 }) {
    stopHeartbeat();
    const live = edgeServer.liveManager.getActivePosition();
    const paper = edgeServer.paperEngine.getOpenPosition();
    const lines = [`HELL shutting down (${signal}).`];
    if (live) lines.push(`LIVE position ${live.symbol} x${live.qty} stays open; its stop order (${live.slOrderId || live.exitOrderId || 'none recorded'}) stays resting at Upstox. Send /login after restart to reconcile.`);
    if (paper) lines.push(`Paper position ${paper.symbol} is saved and resumes after restart.`);
    if (!live && !paper) lines.push('All flat.');
    await edgeServer.auditLog.append('LIFECYCLE', 'SHUTDOWN', signal, { live: live ? { symbol: live.symbol, qty: live.qty, slOrderId: live.slOrderId } : null, paper: paper ? paper.symbol : null });
    await edgeServer.flushPersistence();                       // state first, then the alert
    const tgDone = edgeServer.telegram.dispatchSystem(lines.join('\n')).catch(() => {});
    await Promise.race([tgDone, new Promise(r => { const t = setTimeout(r, telegramWaitMs); if (t.unref) t.unref(); })]);
    try { edgeServer.wss.close(); } catch (_) {}
    await new Promise((resolve) => edgeServer.httpServer.close(() => resolve()));
    if (pool) await pool.end();
    return { liveOpen: Boolean(live), paperOpen: Boolean(paper) };
}

// ----------------------------------------------------------- main
async function main() {
    const env = process.env;
    const problems = checkConfig(env);
    if (problems.length) {
        console.error(`HELL will not start. Fix these settings:\n - ${problems.join('\n - ')}`);
        process.exit(1);
    }

    // Signal handlers go in first, so a SIGTERM during boot is handled too.
    let edgeServer = null, pool = null, timer = null, shuttingDown = false;
    const onSignal = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        const force = setTimeout(() => process.exit(1), 25000); force.unref();
        try {
            if (edgeServer) await shutdownGracefully({ edgeServer, pool, signal, stopHeartbeat: () => clearInterval(timer) });
            else if (pool) await pool.end();
            console.log(`HELL: stopped (${signal})`);
            process.exit(0);
        } catch (err) {
            console.error('HELL shutdown error:', err);
            process.exit(1);
        }
    };
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));

    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: env.DATABASE_URL,
        ssl: env.PGSSL === 'false' ? false : (env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
    });
    const storageAdapter = runnerMod.createPgStorageAdapter(pool);
    await storageAdapter.initSchema();
    console.log('HELL: database ready');

    // Instrument keys. If this fails HELL still boots (Telegram, /status, paper),
    // but every live entry is refused: it never guesses a key.
    let keyMap = Object.create(null);
    let masterError = null;
    let masterDateKey = null;
    async function loadMaster() {
        try {
            keyMap = await fetchUpstoxInstrumentMaster();
            masterError = null;
            masterDateKey = paperMod.getIstDateKeyAndMinutes(Date.now()).dateKey;
            console.log(`HELL: ${Object.keys(keyMap).length} NIFTY instrument keys loaded`);
        } catch (err) {
            masterError = err.message;
            keyMap = Object.create(null);
            console.error(`HELL: instrument master failed: ${err.message}`);
        }
    }
    await loadMaster();

    edgeServer = serverMod.createEdgeServer({
        env,
        storageAdapter,
        runnerFactory: (opts) => runnerMod.createRunner({
            ...opts,
            config: {
                ...opts.config,
                instrumentKeyResolver: (symbol) => {
                    if (masterError) throw new Error(`Instrument master unavailable: ${masterError}`);
                    return keyMap[symbol] || null;
                }
            }
        })
    });

    await edgeServer.boot();     // restores state; always comes back in SHADOW
    await new Promise((resolve) => edgeServer.httpServer.listen(PORT, resolve));
    console.log(`HELL: listening on ${PORT}`);
    if (masterError) edgeServer.telegram.dispatchSystem(`INSTRUMENT MASTER FAILED: ${masterError}\nNo live orders will be placed until it loads.`).catch(() => {});

    let busy = false;
    timer = setInterval(async () => {
        if (busy) return;                      // never overlap ticks
        busy = true;
        try {
            const now = Date.now();
            const { dateKey, minutesIst } = paperMod.getIstDateKeyAndMinutes(now);
            if (dateKey !== masterDateKey && minutesIst >= MASTER_REFRESH_AFTER_MIN_IST) {
                await loadMaster();
                if (masterError) edgeServer.telegram.dispatchSystem(`INSTRUMENT MASTER FAILED: ${masterError}\nNo live orders today until it loads.`).catch(() => {});
                else masterDateKey = dateKey;
            }
            await edgeServer.stepTime(now);
        } catch (err) {
            console.error('HELL heartbeat error:', err);
        } finally { busy = false; }
    }, HEARTBEAT_INTERVAL_MS);

}

if (require.main === module) {
    main().catch((err) => {
        console.error('HELL FATAL BOOT ERROR:', err);
        process.exit(1);
    });
}

module.exports = { checkConfig, buildNiftyKeyMap, hellSymbol, fetchUpstoxInstrumentMaster, shutdownGracefully, main, REQUIRED_ENV };
