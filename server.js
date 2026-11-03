'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const runnerMod = require('./runner.js');
const paperMod = require('./paper_engine.js');
const liveMod = require('./upstox_live_layer.js');
const upstoxMod = require('./upstox_client.js');

const MAX_SIGNAL_AGE_MS = 120000;
const WARNING_RATE_LIMIT_MS = 5 * 60000;
const WS_AUTH_TIMEOUT_MS = 5000;
const WS_MAX_FAILURES = 5;
const WS_LOCKOUT_MS = 15 * 60000;
const OAUTH_STATE_TTL_MS = 10 * 60000;

const KV_RISK = 'hell_risk_state';
const KV_PAPER = 'hell_paper_state';
const KV_LIVE = 'hell_live_state';

function formatIst(epochMs) {
    const d = new Date(epochMs + 19800000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST`;
}

function safeSecretEqual(inputStr, secretStr) {
    if (typeof inputStr !== 'string' || typeof secretStr !== 'string' || secretStr.length === 0) return false;
    const a = Buffer.from(inputStr, 'utf8');
    const b = Buffer.from(secretStr, 'utf8');
    if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
    return crypto.timingSafeEqual(a, b);
}

function sanitizeSecrets(str, secrets = []) {
    if (typeof str !== 'string') return '';
    let out = str;
    for (const s of secrets) if (typeof s === 'string' && s.length > 0) out = out.split(s).join('[REDACTED]');
    return out;
}

function defaultTelegramRequest(botToken, chatId, text) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ chat_id: chatId, text });
        const req = https.request({
            hostname: 'api.telegram.org', port: 443, path: `/bot${botToken}/sendMessage`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => { let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode || 500, body: parsed }); });
        });
        req.on('error', () => reject(new Error('Telegram network error')));
        req.write(payload);
        req.end();
    });
}

async function defaultGetPublicIp(fetchFn) {
    const res = await fetchFn('https://api.ipify.org?format=json');
    const j = await res.json();
    if (!j || typeof j.ip !== 'string') throw new Error('ipify returned no ip');
    return j.ip;
}

function createTelegramDispatcher({ botToken, chatId, getTime, sleepFn = (ms) => new Promise(r => setTimeout(r, ms)), httpSend = defaultTelegramRequest, storageAdapter, onAlertFailed }) {
    if (!botToken || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
    const attemptLog = [];
    const sentSignalLevels = new Set();
    const pendingSignalLocks = new Set();
    const lastWarningByReason = Object.create(null);

    function logAttempt(e) {
        attemptLog.push(Object.freeze({ ts: e.ts, kind: e.kind, refId: e.refId, attempt: e.attempt, outcome: e.outcome, status: e.status || null, detail: sanitizeSecrets(e.detail || '', [botToken, chatId]) }));
        if (attemptLog.length > 2000) attemptLog.shift();
    }

    async function sendWithRetry(kind, refId, text) {
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                const res = await httpSend(botToken, chatId, text);
                if (res && res.status >= 200 && res.status < 300) { logAttempt({ ts: getTime(), kind, refId, attempt, outcome: 'OK', status: res.status }); return { ok: true, attempts: attempt }; }
                if (res && res.status === 429) {
                    const ra = res.body && res.body.parameters && Number(res.body.parameters.retry_after);
                    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * Math.pow(2, attempt - 1);
                    logAttempt({ ts: getTime(), kind, refId, attempt, outcome: 'RATE_LIMIT_429', status: 429 });
                    if (attempt < 5) await sleepFn(waitMs);
                } else if (res && res.status >= 500) {
                    logAttempt({ ts: getTime(), kind, refId, attempt, outcome: 'HTTP_5XX', status: res.status });
                    if (attempt < 5) await sleepFn(1000 * Math.pow(2, attempt - 1));
                } else {
                    logAttempt({ ts: getTime(), kind, refId, attempt, outcome: 'HTTP_ERROR', status: res ? res.status : 0 });
                    break;
                }
            } catch (err) {
                logAttempt({ ts: getTime(), kind, refId, attempt, outcome: 'NETWORK_ERR', detail: err ? err.message : 'err' });
                if (attempt < 5) await sleepFn(1000 * Math.pow(2, attempt - 1));
            }
        }
        return { ok: false };
    }

    return {
        restoreSentState: async () => {
            if (!storageAdapter || typeof storageAdapter.getSignals !== 'function') return;
            for (const s of await storageAdapter.getSignals()) if (s.alertState === 'ALERT_SENT' || s.status === 'DELIVERED') sentSignalLevels.add(s.levelId);
        },
        dispatchSignal: async (sig) => {
            if (sentSignalLevels.has(sig.levelId) || pendingSignalLocks.has(sig.levelId)) return true;
            pendingSignalLocks.add(sig.levelId);
            try {
                const isLate = sig.candle && (getTime() - (sig.candle.startMs + 300000)) > MAX_SIGNAL_AGE_MS;
                const text = `SIGNAL${isLate ? ' (MISSED)' : ''}\nTier: ${sig.tier}\nSide: ${sig.side}\nSymbol: ${(sig.contract && sig.contract.symbol) || 'N/A'}\nLevel: ${sig.level}\nQuote: ${sig.quoteStatus}`;
                const res = await sendWithRetry(isLate ? 'MISSED_SIGNAL' : 'SIGNAL', sig.signalId, text);
                if (res.ok) { sentSignalLevels.add(sig.levelId); return true; }
                if (typeof onAlertFailed === 'function') onAlertFailed({ type: 'ALERT_FAILED', signalId: sig.signalId, levelId: sig.levelId, ts: getTime() });
                return false;
            } finally { pendingSignalLocks.delete(sig.levelId); }
        },
        dispatchWarning: async (warn) => {
            const nowMs = getTime();
            const key = warn.reason || warn.type;
            if (!/RECOVERED$/.test(warn.type)) {
                const last = lastWarningByReason[key] || 0;
                if (last > 0 && nowMs - last < WARNING_RATE_LIMIT_MS) return { skipped: true, reason: 'rate_limited' };
                lastWarningByReason[key] = nowMs;
            }
            return sendWithRetry('WARNING', `${warn.type}_${nowMs}`, `${warn.type}\nReason: ${warn.reason}\nTime: ${formatIst(nowMs)}`);
        },
        dispatchSystem: async (text) => sendWithRetry('SYSTEM', `SYS_${getTime()}`, `HELL\n${text}\nTime: ${formatIst(getTime())}`),
        getAttemptLog: () => [...attemptLog]
    };
}

function createEdgeServer({
    env = process.env,
    getTime = () => Date.now(),
    storageAdapter,
    feeds = [],
    telegramHttpSend,
    sleepFn = (ms) => new Promise(r => setTimeout(r, ms)),
    fetchFn = globalThis.fetch,
    getPublicIp = null,
    brokerClientFactory = null,        // tests inject a simulated broker; production builds the real Upstox client
    runnerFactory = runnerMod.createRunner
}) {
    const wsSecret = env.WS_SECRET;
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!wsSecret || typeof wsSecret !== 'string' || wsSecret.length < 4) throw new Error('WS_SECRET env var is required');

    const failedAlerts = [];
    const wsClients = new Set();
    const ipFailures = new Map();
    const oauthStates = new Map();
    const latestQuotes = Object.create(null);
    const brokerSession = { token: null, dateKey: null, rejected: false };
    const secretsList = () => [wsSecret, botToken, chatId, env.UPSTOX_CLIENT_SECRET, env.TELEGRAM_WEBHOOK_SECRET, brokerSession.token].filter(Boolean);
    const redact = (s) => sanitizeSecrets(s, secretsList());
    const auditLog = paperMod.createDecisionAuditLog(getTime, storageAdapter, redact);
    const todayKey = () => paperMod.getIstDateKeyAndMinutes(getTime()).dateKey;

    function broadcastDisplay(payload) {
        const raw = redact(JSON.stringify(payload));
        for (const ws of wsClients) if (ws.readyState === 1) ws.send(raw);
    }

    const telegram = createTelegramDispatcher({
        botToken, chatId, getTime, sleepFn, httpSend: telegramHttpSend, storageAdapter,
        onAlertFailed: (evt) => { failedAlerts.push(evt); if (failedAlerts.length > 200) failedAlerts.shift(); broadcastDisplay({ type: 'alert_failed', alert: evt }); }
    });
    const alert = (text) => telegram.dispatchSystem(text).catch(() => {});

    // ---------------- Durable state (write on every change, restore on boot) -------------
    const kvSupported = Boolean(storageAdapter && typeof storageAdapter.saveKv === 'function' && typeof storageAdapter.loadKv === 'function');
    let kvFailedReason = kvSupported ? null : 'STORAGE_ADAPTER_MISSING_saveKv_loadKv';
    const kvLatest = Object.create(null);
    const kvWriting = Object.create(null);

    function persist(key, json) {
        kvLatest[key] = json;
        if (!kvSupported || kvWriting[key]) return;
        kvWriting[key] = (async () => {
            try {
                while (kvLatest[key] !== undefined) {
                    const v = kvLatest[key];
                    kvLatest[key] = undefined;
                    await storageAdapter.saveKv(key, v);
                }
                if (kvFailedReason) { kvFailedReason = null; telegram.dispatchWarning({ type: 'PERSISTENCE_RECOVERED', reason: key }).catch(() => {}); }
            } catch (err) {
                kvFailedReason = `KV_WRITE_FAILED:${key}`;
                telegram.dispatchWarning({ type: 'PERSISTENCE_FAILED', reason: `${key}: ${err && err.message}` }).catch(() => {});
            } finally { kvWriting[key] = null; }
        })();
    }
    async function flushPersistence() { await Promise.all(Object.values(kvWriting).filter(Boolean)); }

    // ---------------- Upstox session & client ----------------
    function getAccessToken() {
        if (!brokerSession.token || brokerSession.rejected || brokerSession.dateKey !== todayKey()) return null;
        return brokerSession.token;
    }
    async function onBrokerAuthError(httpStatus) {
        if (brokerSession.rejected) return;
        brokerSession.rejected = true;
        if (riskGovernor.getStateSnapshot().mode === 'LIVE') await riskGovernor.disarmToShadow(`BROKER_AUTH_${httpStatus}`, 'SYSTEM');
        await telegram.dispatchWarning({ type: 'BROKER_TOKEN_INVALID', reason: `Upstox returned ${httpStatus}. New entries blocked. Resting stops at Upstox are unaffected. Send /login.` }).catch(() => {});
    }
    const brokerClient = brokerClientFactory
        ? brokerClientFactory({ getAccessToken, onAuthError: onBrokerAuthError })
        : upstoxMod.createUpstoxClient({ fetchFn, getAccessToken, algoName: env.UPSTOX_ALGO_NAME, onAuthError: (s) => { onBrokerAuthError(s); } });
    function getBrokerClient() {
        if (!getAccessToken()) throw new Error('UPSTOX_NOT_LOGGED_IN_TODAY');
        return brokerClient;
    }

    // ---------------- Core components ----------------
    let runnerRef = null;
    const riskGovernor = paperMod.createRiskGovernor({
        getTime,
        gapLedger: { getOpenGaps: () => runnerRef ? runnerRef.getGapLedger().getOpenGaps() : {} },
        failoverMgr: { getSource: () => runnerRef ? runnerRef.getFailoverManager().getSource() : 'UNKNOWN' },
        isPersistenceFailed: () => Boolean(kvFailedReason) || (runnerRef ? runnerRef.getPersistenceHealth().currentlyFailed : false),
        auditLog,
        config: {
            maxDailyLossRs: env.DAILY_LOSS_CAP_RS, perTradeRiskRs: env.PER_TRADE_RISK_RS, maxTradesPerDay: env.MAX_TRADES_PER_DAY,
            maxWeeklyLossRs: env.MAX_WEEKLY_LOSS_RS, totalCapitalAvailableRs: env.TOTAL_CAPITAL_RS,
            stopTriggerOffsetRs: env.STOP_TRIGGER_OFFSET_RS, stopLimitFloorOffsetRs: env.STOP_LIMIT_FLOOR_OFFSET_RS,
            stopChaserMaxSlippageRs: env.STOP_CHASER_MAX_SLIPPAGE_RS, targetOffsetRs: env.TARGET_OFFSET_RS
        },
        // LIVE entries are sized against real Upstox funds; paper uses TOTAL_CAPITAL_RS.
        getAvailableCapitalFn: async () => riskGovernor.getStateSnapshot().mode === 'LIVE'
            ? getBrokerClient().getAvailableMargin()
            : Number(env.TOTAL_CAPITAL_RS) || 10000,
        onStateChange: (json) => persist(KV_RISK, json)
    });
    const paperEngine = paperMod.createPaperTradingEngine({ getTime, riskGovernor, auditLog, onStateChange: (json) => persist(KV_PAPER, json) });
    let runnerRef2 = null;   // set once the runner exists (it owns the instrument-key map)
    const liveManager = liveMod.createLiveOrderManager({
        getTime, riskGovernor, auditLog, getBrokerClient, sleepFn, onAlert: alert, onStateChange: (json) => persist(KV_LIVE, json),
        resolveInstrumentKey: (sym) => (runnerRef2 && typeof runnerRef2.resolveInstrumentKey === 'function') ? runnerRef2.resolveInstrumentKey(sym) : null,
        chaseConfig: { escalateAfterMs: env.EXIT_ESCALATE_AFTER_MS, stepMs: env.EXIT_ESCALATION_STEP_MS, floorWaitMs: env.EXIT_FLOOR_WAIT_MS }
    });

    async function onOptionQuote(quote) {
        if (!quote || !quote.symbol) return;
        latestQuotes[quote.symbol] = { ...quote, receivedAtMs: getTime() };
        liveManager.onQuote(quote);
        await paperEngine.onOptionQuote(quote, getTime());
    }
    const latestBidFor = (sym) => (sym && latestQuotes[sym] && Number.isFinite(latestQuotes[sym].bid)) ? latestQuotes[sym].bid : null;

    const runner = runnerFactory({
        getTime, storageAdapter, feeds,
        config: { expiry: env.EXPIRY, isMonthly: env.IS_MONTHLY === 'true', lotSize: env.LOT_SIZE },
        onSignal: async (sig) => {
            const ok = await telegram.dispatchSignal(sig);
            const mode = riskGovernor.getEffectiveMode(getTime());
            let exec = { status: 'SHADOW' };
            if (mode === 'LIVE') exec = await liveManager.executeSignalEntry(sig);
            else if (mode === 'PAPER') exec = await paperEngine.evaluateSignalForEntry(sig);
            await auditLog.append('SIGNAL', 'EXECUTION_RESULT', exec.status, { signalId: sig.signalId, mode, reason: exec.reason || null });
            broadcastDisplay({ type: 'signal', signal: { signalId: sig.signalId, alertState: ok ? 'ALERT_SENT' : 'ALERT_FAILED', executionStatus: exec.status, mode } });
            return ok;
        },
        onOptionQuote,
        onWarning: async (warn) => { await telegram.dispatchWarning(warn); broadcastDisplay({ type: 'warning', warning: warn }); }
    });
    runnerRef = runner;
    runnerRef2 = runner;

    // ---------------- Operator actions ----------------
    async function killEverything(source) {
        await riskGovernor.triggerEmergencyKill(`${source} kill`, source);
        const out = { paper: null, live: null };
        const pPos = paperEngine.getOpenPosition();
        if (pPos) out.paper = await paperEngine.emergencyFlattenNow(latestBidFor(pPos.symbol), `EMERGENCY_KILL_${source}`, getTime());
        if (liveManager.getActivePosition() || liveManager.hasPendingEntry()) {
            if (getAccessToken()) out.live = await liveManager.killAll(`EMERGENCY_KILL_${source}`, latestBidFor(liveManager.getActivePosition() && liveManager.getActivePosition().symbol));
            else out.live = { ok: false, reason: 'NOT_LOGGED_IN: resting Upstox SL still protects the position; close it manually in the Upstox app' };
        }
        await alert(`EMERGENCY KILL (${source}). Paper: ${out.paper ? JSON.stringify({ exit: out.paper.exitReason || out.paper.reason }) : 'flat'}. Live: ${out.live ? JSON.stringify(out.live) : 'flat'}. Use /admin/clear-kill to re-enable.`);
        return out;
    }

    async function flattenWithoutKill(source) {
        await riskGovernor.disarmToShadow(`${source} flatten`, source);
        const out = { paper: null, live: null };
        const pPos = paperEngine.getOpenPosition();
        if (pPos) out.paper = await paperEngine.emergencyFlattenNow(latestBidFor(pPos.symbol), `MANUAL_FLATTEN_${source}`, getTime());
        if (liveManager.getActivePosition() && getAccessToken()) out.live = await liveManager.killAll(`MANUAL_FLATTEN_${source}`, latestBidFor(liveManager.getActivePosition().symbol));
        return out;
    }

    async function reconcileAndMaybeClear() {
        const r = await liveManager.reconcileWithBroker();
        if (r.matched) await riskGovernor.clearReconciliationMismatch('OPERATOR_RECONCILE');
        return r;
    }

    async function armLiveWithChecks(source) {
        const fail = (code, error) => ({ ok: false, code, error });
        if (!env.EXPECTED_STATIC_IP) return fail(403, 'EXPECTED_STATIC_IP not configured');
        let ip;
        try { ip = await (getPublicIp ? getPublicIp() : defaultGetPublicIp(fetchFn)); } catch (err) { return fail(503, `Public IP check failed: ${err.message}`); }
        if (ip !== env.EXPECTED_STATIC_IP) return fail(403, `Egress IP ${ip} does not match registered static IP`);
        if (!brokerClientFactory && !env.UPSTOX_ALGO_NAME) return fail(403, 'UPSTOX_ALGO_NAME not configured (orders need X-Algo-Name)');
        if (!getAccessToken()) return fail(400, 'Upstox not logged in today (send /login)');
        try { await brokerClient.getProfile(); } catch (err) { return fail(401, `Upstox token check failed: ${err.message}`); }
        let recon;
        try { recon = await liveManager.reconcileWithBroker(); } catch (err) { return fail(503, `Reconcile failed: ${err.message}`); }
        if (!recon.matched) return fail(409, 'Reconciliation mismatch');
        if (riskGovernor.getStateSnapshot().reconciliationMismatch) return fail(409, 'Earlier reconciliation mismatch not cleared (run reconcile)');
        const grad = paperEngine.canArmLive();
        if (!grad.allowed) return fail(403, grad.reason);
        try {
            const out = await riskGovernor.armMode('LIVE', source, grad);
            await alert(`LIVE ARMED via ${source}. Static IP ${ip} verified, Upstox session OK, reconcile matched, graduation: ${grad.sessionsCount} sessions / ${grad.tradesCount} trades / ₹${grad.totalNetPnl}.`);
            return { ok: true, ...out };
        } catch (err) { return fail(403, err.message); }
    }

    function newLoginUrl() {
        if (!env.UPSTOX_CLIENT_ID || !env.UPSTOX_REDIRECT_URI) throw new Error('UPSTOX_CLIENT_ID / UPSTOX_REDIRECT_URI not configured');
        const state = crypto.randomBytes(16).toString('hex');
        oauthStates.set(state, getTime() + OAUTH_STATE_TTL_MS);
        return upstoxMod.buildUpstoxLoginUrl({ clientId: env.UPSTOX_CLIENT_ID, redirectUri: env.UPSTOX_REDIRECT_URI, state });
    }

    async function completeLogin(token) {
        brokerSession.token = token; brokerSession.dateKey = todayKey(); brokerSession.rejected = false;
        await brokerClient.getProfile();
        const boot = await liveManager.recoverOnBoot();
        const recon = await liveManager.reconcileWithBroker();
        await alert(`Upstox connected for ${brokerSession.dateKey}. Boot recovery: ${boot.status}. Reconcile: ${recon.matched ? 'matched' : 'MISMATCH (live blocked)'}.`);
        return { boot, recon };
    }

    async function handleTelegramUpdate(update) {
        if (!update || !update.message) return { handled: false };
        const msg = update.message;
        if (String(msg.chat && msg.chat.id) !== String(chatId) || String(msg.from && msg.from.id) !== String(chatId)) {
            await auditLog.append('SECURITY', 'UNAUTHORIZED_TELEGRAM_COMMAND', 'Ignored', { text: String(msg.text || '').slice(0, 50) });
            return { handled: false, reason: 'UNAUTHORIZED_SENDER' };
        }
        const cmd = String(msg.text || '').trim().toLowerCase().split(/\s+/)[0];
        try {
            if (cmd === '/kill' || cmd === '/stop') return { handled: true, action: 'KILL', result: await killEverything('TELEGRAM') };
            if (cmd === '/flatten') { const r = await flattenWithoutKill('TELEGRAM'); await alert(`FLATTEN: ${JSON.stringify(r)}`); return { handled: true, result: r }; }
            if (cmd === '/disarm') { await riskGovernor.disarmToShadow('Telegram /disarm', 'TELEGRAM'); await alert('DISARMED (SHADOW)'); return { handled: true }; }
            if (cmd === '/paper') { const r = await riskGovernor.armMode('PAPER', 'TELEGRAM'); await alert(`PAPER ARMED for ${r.armedDateKey}`); return { handled: true, result: r }; }
            if (cmd === '/confirm-live') { await riskGovernor.confirmLiveArmOnTelegram(getTime()); await alert('Live confirmation recorded for today. Now send /live.'); return { handled: true }; }
            if (cmd === '/live') { const r = await armLiveWithChecks('TELEGRAM'); if (!r.ok) await alert(`LIVE NOT ARMED: ${r.error}`); return { handled: true, result: r }; }
            if (cmd === '/login') { await alert(`Upstox login (valid 10 min):\n${newLoginUrl()}`); return { handled: true }; }
            if (cmd === '/reconcile') { const r = await reconcileAndMaybeClear(); await alert(`Reconcile: ${r.matched ? 'matched' : 'MISMATCH'}`); return { handled: true, result: r }; }
            if (cmd === '/status') {
                const s = riskGovernor.getStateSnapshot(getTime());
                const g = paperEngine.canArmLive();
                await alert(`mode=${s.mode} kill=${s.emergencyHalted} recon=${s.reconciliationMismatch ? 'MISMATCH' : 'ok'} multiday=${s.multiDayHaltReason || 'ok'}\ntoday: ${s.today.tradeCount} trades, net ₹${s.today.realizedNetPnl}\nupstox=${getAccessToken() ? 'logged in' : 'not logged in'} storage=${kvFailedReason || 'ok'}\npaper pos=${paperEngine.getOpenPosition() ? paperEngine.getOpenPosition().symbol : 'flat'} live pos=${liveManager.getActivePosition() ? liveManager.getActivePosition().symbol : 'flat'}\ngraduation: ${g.allowed ? 'PASSED' : g.reason}`);
                return { handled: true };
            }
        } catch (err) {
            await alert(`Command ${cmd} failed: ${redact(err.message)}`);
            return { handled: true, error: err.message };
        }
        return { handled: false };
    }

    // ---------------- HTTP ----------------
    const app = express();
    app.use(express.json());

    function requireHttpAuth(req, res, next) {
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        const nowMs = getTime();
        const rec = ipFailures.get(ip);
        if (rec && rec.lockedUntil > nowMs) return res.status(429).json({ error: 'Locked out' });
        const hdr = req.headers['authorization'] || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-edge-secret'] || '');
        if (!safeSecretEqual(String(token), wsSecret)) {
            const count = (rec ? rec.count : 0) + 1;
            ipFailures.set(ip, { count, lockedUntil: count >= WS_MAX_FAILURES ? nowMs + WS_LOCKOUT_MS : 0 });
            return res.status(count >= WS_MAX_FAILURES ? 429 : 401).json({ error: 'Unauthorized' });
        }
        ipFailures.delete(ip);
        next();
    }
    const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { res.status(500).json({ error: redact(err.message) }); } };

    app.get('/health', (req, res) => {
        res.json({
            ok: !kvFailedReason, storage: kvFailedReason || 'ok',
            activeSource: runner.getFailoverManager().getSource(), persistence: runner.getPersistenceHealth(),
            governor: riskGovernor.getStateSnapshot(getTime()), upstoxLoggedIn: Boolean(getAccessToken()),
            paperOpen: Boolean(paperEngine.getOpenPosition()), liveOpen: Boolean(liveManager.getActivePosition())
        });
    });
    app.post('/admin/arm-paper', requireHttpAuth, wrap(async (req, res) => { res.json({ ok: true, ...(await riskGovernor.armMode('PAPER', 'HTTP_ADMIN')) }); }));
    app.post('/admin/arm-live', requireHttpAuth, wrap(async (req, res) => { const r = await armLiveWithChecks('HTTP_ADMIN'); res.status(r.ok ? 200 : r.code).json(r); }));
    app.post('/admin/disarm', requireHttpAuth, wrap(async (req, res) => { res.json(await riskGovernor.disarmToShadow('HTTP disarm', 'HTTP_ADMIN')); }));
    app.post('/admin/kill', requireHttpAuth, wrap(async (req, res) => { res.json({ ok: true, ...(await killEverything('HTTP_ADMIN')) }); }));
    app.post('/admin/flatten', requireHttpAuth, wrap(async (req, res) => { res.json({ ok: true, ...(await flattenWithoutKill('HTTP_ADMIN')) }); }));
    app.post('/admin/clear-kill', requireHttpAuth, wrap(async (req, res) => { res.json(await riskGovernor.clearEmergencyKill('HTTP_ADMIN')); }));
    app.post('/admin/clear-multiday-halt', requireHttpAuth, wrap(async (req, res) => {
        try { res.json(await riskGovernor.clearMultiDayHalt(req.body && req.body.challengePhrase, 'HTTP_ADMIN')); } catch (err) { res.status(400).json({ error: err.message }); }
    }));
    app.post('/admin/reconcile', requireHttpAuth, wrap(async (req, res) => { res.json(await reconcileAndMaybeClear()); }));
    app.get('/admin/graduation', requireHttpAuth, (req, res) => res.json(paperEngine.getGraduationEvidence()));
    app.get('/admin/upstox/login-url', requireHttpAuth, wrap(async (req, res) => res.json({ url: newLoginUrl() })));

    // Upstox redirects the browser here. Protected by the single-use OAuth state, not the bearer secret.
    app.get('/upstox/callback', wrap(async (req, res) => {
        const { code, state } = req.query || {};
        const exp = state && oauthStates.get(String(state));
        if (!exp || exp < getTime() || !code) return res.status(400).send('Invalid or expired login link. Send /login again.');
        oauthStates.delete(String(state));
        const token = await upstoxMod.exchangeUpstoxAuthCode({ fetchFn, code: String(code), clientId: env.UPSTOX_CLIENT_ID, clientSecret: env.UPSTOX_CLIENT_SECRET, redirectUri: env.UPSTOX_REDIRECT_URI });
        const r = await completeLogin(token);
        res.send(`HELL: Upstox connected. Recovery ${r.boot.status}, reconcile ${r.recon.matched ? 'matched' : 'MISMATCH'}. You can close this page.`);
    }));

    app.post('/telegram/webhook', wrap(async (req, res) => {
        if (!safeSecretEqual(String(req.headers['x-telegram-bot-api-secret-token'] || ''), String(env.TELEGRAM_WEBHOOK_SECRET || ''))) return res.status(401).end();
        res.status(200).json({ ok: true });
        handleTelegramUpdate(req.body).catch(() => {});
    }));

    const httpServer = http.createServer(app);
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        if ((ipFailures.get(ip) || {}).lockedUntil > getTime() || String(req.url || '').includes('secret=')) return ws.close(1008);
        let authenticated = false;
        const timer = setTimeout(() => { if (!authenticated) ws.close(1008); }, WS_AUTH_TIMEOUT_MS);
        ws.on('message', (raw) => {
            if (authenticated) return;
            let parsed = null;
            try { parsed = JSON.parse(String(raw)); } catch (_) {}
            if (safeSecretEqual(parsed && parsed.secret, wsSecret)) {
                authenticated = true; clearTimeout(timer); ipFailures.delete(ip); wsClients.add(ws);
                ws.send(redact(JSON.stringify({ type: 'auth_ok', ts: getTime(), failedAlerts })));
            } else {
                clearTimeout(timer);
                const count = ((ipFailures.get(ip) || {}).count || 0) + 1;
                ipFailures.set(ip, { count, lockedUntil: count >= WS_MAX_FAILURES ? getTime() + WS_LOCKOUT_MS : 0 });
                ws.close(1008);
            }
        });
        ws.on('close', () => { clearTimeout(timer); wsClients.delete(ws); });
    });

    // ---------------- Lifecycle ----------------
    async function boot() {
        if (kvSupported) {
            for (const [key, target] of [[KV_RISK, riskGovernor], [KV_PAPER, paperEngine], [KV_LIVE, liveManager]]) {
                try {
                    const v = await storageAdapter.loadKv(key);
                    if (v) target.importState(v);
                } catch (err) {
                    kvFailedReason = `KV_RESTORE_FAILED:${key}`;
                    await alert(`BOOT: could not restore ${key} (${err.message}). Entries blocked until fixed.`);
                }
            }
        }
        await riskGovernor.finalizeDueSessions(getTime());
        await telegram.restoreSentState();
        await runner.boot();
        const lp = liveManager.getActivePosition();
        alert(`BOOT: HELL started in SHADOW. Storage: ${kvFailedReason || 'ok'}.${lp ? ` A live position (${lp.symbol}) was open before restart — its Upstox SL still rests at the broker. Send /login now to reconcile.` : ' Send /login to connect Upstox.'}`);
    }

    // Heartbeats never overlap: a tick that arrives while the previous one is still
    // running is skipped (a slow tick delays the next one, it never runs alongside it).
    let stepping = false;
    async function stepTime(nowMs = getTime()) {
        if (stepping) return { skipped: true, reason: 'PREVIOUS_TICK_RUNNING' };
        stepping = true;
        try { return await stepTimeInner(nowMs); } finally { stepping = false; }
    }
    async function stepTimeInner(nowMs) {
        await runner.stepTime(nowMs);
        const tech = riskGovernor.checkTechnicalHealth(nowMs);
        paperEngine.noteHeartbeat(nowMs, tech.ok);
        await paperEngine.stepPositionLifecycle(nowMs);
        if (liveManager.getActivePosition() && getAccessToken()) await liveManager.stepLivePosition(nowMs);
        await riskGovernor.finalizeDueSessions(nowMs);
        broadcastDisplay({ type: 'heartbeat', ts: nowMs, mode: riskGovernor.getEffectiveMode(nowMs) });
    }

    return {
        app, httpServer, wss, runner, telegram, riskGovernor, paperEngine, liveManager, auditLog,
        handleTelegramUpdate, onOptionQuote, boot, stepTime, flushPersistence,
        killEverything, armLiveWithChecks, completeLogin,
        _getBrokerSession: () => ({ ...brokerSession, token: brokerSession.token ? '[set]' : null }),
        _oauthStateCount: () => oauthStates.size
    };
}

module.exports = { MAX_SIGNAL_AGE_MS, createEdgeServer, createTelegramDispatcher, formatIst };
