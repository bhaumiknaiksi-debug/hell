'use strict';
// HELL test suite (Stage 4 + Stage 5). Run: node test.js
// Uses your real engine.js / runner.js if present; otherwise loads minimal stubs
// so the suite runs standalone. The broker is a SIMULATOR (clearly labelled) —
// passing here proves HELL's logic, not Upstox's real behaviour.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const assert = require('assert');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && path.dirname(parent.filename) === __dirname) {
        if (request === './engine.js' && !fs.existsSync(path.join(__dirname, 'engine.js'))) return { MAX_CLOCK_SKEW_MS: 2000 };
        if (request === './runner.js' && !fs.existsSync(path.join(__dirname, 'runner.js'))) return { createRunner: () => { throw new Error('stub runner: inject runnerFactory'); } };
    }
    return origLoad.apply(this, arguments);
};

const paperMod = require('./paper_engine.js');
const upstoxMod = require('./upstox_client.js');
const serverMod = require('./server.js');
const runnerMod = require('./runner.js');
const entrypoint = require('./index.js');

// ---------------------------------------------------------------- harness
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const IST = 5.5 * 3600000;
const at = (h, m, s = 0, day = 2) => Date.UTC(2026, 10, day, h, m, s) - IST;   // Nov 2026 IST
const SYMBOL = 'NIFTY26N0325000CE';
const IKEY = 'NSE_FO|43919';
const TIGHT = { STOP_TRIGGER_OFFSET_RS: '5', STOP_LIMIT_FLOOR_OFFSET_RS: '6', STOP_CHASER_MAX_SLIPPAGE_RS: '7' }; // test-only config

function createClock(start) {
    const c = { now: start };
    c.getTime = () => c.now;
    c.sleep = async (ms) => { c.now += ms; await new Promise(r => setImmediate(r)); };
    return c;
}

function createKv({ failWrites = false } = {}) {
    const data = {};
    return { data, failWrites, async saveKv(k, v) { if (this.failWrites) throw new Error('disk full'); data[k] = v; }, async loadKv(k) { return data[k]; }, async appendDecisionAudit() {} };
}

function createFakeRunner() {
    const r = { opts: null, gaps: {}, source: 'FYERS' };
    r.factory = (opts) => {
        r.opts = opts;
        return {
            getGapLedger: () => ({ getOpenGaps: () => r.gaps }),
            getFailoverManager: () => ({ getSource: () => r.source }),
            getPersistenceHealth: () => ({ currentlyFailed: false }),
            boot: async () => {}, stepTime: async () => {}
        };
    };
    return r;
}

// SIMULATED broker with Upstox-like semantics: place returns only an order id,
// fills appear later via order status, SL goes trigger-pending -> open -> complete.
function createSimBroker(clock, opts = {}) {
    const sim = {
        bid: 100, ask: 100.2, margin: 50000, entryFill: 'instant', partialQty: 25, allowSlToLimit: true, slReject: false,
        orders: new Map(), pos: Object.create(null), calls: [], nakedObserved: 0, watchNaked: false, seq: 0,
        tokenSeen: [], ...opts
    };
    const terminal = (o) => ['COMPLETE', 'REJECTED', 'CANCELLED'].includes(o.status);
    function applyFill(o, qty, price) {
        if (qty <= 0) return;
        const p = sim.pos[o.instrumentKey] || (sim.pos[o.instrumentKey] = { netQty: 0, avg: 0, symbol: o.symbol });
        if (o.side === 'BUY') { p.avg = (p.avg * p.netQty + price * qty) / (p.netQty + qty); p.netQty += qty; } else p.netQty -= qty;
        o.avgFillPrice = o.filledQty > 0 ? ((o.avgFillPrice * o.filledQty) + price * qty) / (o.filledQty + qty) : price;
        o.filledQty += qty;
    }
    // SELL LIMIT matching. With sim.bidLevels ([{ price, qty }], best first) the book has
    // finite depth; otherwise there is unlimited size at sim.bid. A sell fills at the
    // bid it hits (price >= limit), like a real exchange.
    function matchSell(o) {
        let rem = o.quantity - o.filledQty;
        if (Array.isArray(sim.bidLevels)) {
            for (const lv of sim.bidLevels) {
                if (rem <= 0) break;
                if (lv.qty > 0 && lv.price >= o.limitPrice) { const q = Math.min(rem, lv.qty); lv.qty -= q; applyFill(o, q, lv.price); rem -= q; }
            }
        } else if (sim.bid >= o.limitPrice) { applyFill(o, rem, sim.bid); rem = 0; }
        if (rem <= 0) o.status = 'COMPLETE';
        else if (o.filledQty > 0 && sim.cancelSellAfterPartial) { sim.cancelSellAfterPartial = false; o.status = 'CANCELLED'; }
        else o.status = 'OPEN';
    }
    function evaluate(o) {
        if (terminal(o)) return;
        if (o.side === 'BUY') {
            if (sim.entryFill === 'instant' && sim.ask <= o.limitPrice) { applyFill(o, o.quantity - o.filledQty, sim.ask); o.status = 'COMPLETE'; }
            else if (sim.entryFill === 'partial' && o.filledQty === 0) { applyFill(o, sim.partialQty, sim.ask); o.status = 'OPEN'; }
            else o.status = 'OPEN';
        } else if (o.orderType === 'SL') {
            if (o.status === 'TRIGGER_PENDING' && sim.bid <= o.triggerPrice) o.status = 'OPEN';
            if (o.status === 'OPEN') matchSell(o);
        } else {
            matchSell(o);
        }
    }
    function checkNaked() {
        if (!sim.watchNaked) return;
        for (const [k, p] of Object.entries(sim.pos)) {
            if (p.netQty > 0 && ![...sim.orders.values()].some(o => o.instrumentKey === k && o.side === 'SELL' && !terminal(o))) sim.nakedObserved++;
        }
    }
    const view = (o) => ({ ...o });
    sim.factory = ({ getAccessToken, onAuthError }) => {
        const auth = () => {
            const t = getAccessToken();
            sim.tokenSeen.push(t);
            if (!t || sim.forceAuthFail) { onAuthError(401); const e = new Error('401'); e.httpStatus = 401; throw e; }
        };
        return {
            async placeOrder(o) {
                auth(); sim.calls.push({ op: 'place', side: o.side, orderType: o.orderType, qty: o.quantity, limitPrice: o.limitPrice, triggerPrice: o.triggerPrice });
                const id = `SIM${++sim.seq}`;
                const ord = { brokerOrderId: id, instrumentKey: o.instrumentKey, symbol: o.symbol, side: o.side, orderType: o.orderType, quantity: o.quantity, limitPrice: o.limitPrice, triggerPrice: o.triggerPrice || 0, tag: o.tag, filledQty: 0, avgFillPrice: null, status: 'PENDING' };
                if (o.orderType === 'SL') ord.status = sim.slReject ? 'REJECTED' : 'TRIGGER_PENDING';
                sim.orders.set(id, ord);
                checkNaked();
                if (o.side === 'BUY' && sim.onBuyPlaced) { const f = sim.onBuyPlaced; sim.onBuyPlaced = null; setImmediate(f); }
                return { brokerOrderId: id };              // like Upstox: id only, no fill info
            },
            async getOrder(id) { auth(); const o = sim.orders.get(id); if (!o) throw new Error('no order'); evaluate(o); checkNaked(); return view(o); },
            async getOrders() { auth(); for (const o of sim.orders.values()) evaluate(o); return [...sim.orders.values()].map(view); },
            async modifyOrder(id, m) {
                auth(); const o = sim.orders.get(id); sim.calls.push({ op: 'modify', id, ...m });
                if (!o || terminal(o)) throw new Error('cannot modify terminal order');
                if (o.orderType === 'SL' && m.orderType === 'LIMIT' && !sim.allowSlToLimit) throw new Error('order type change not allowed');
                Object.assign(o, { orderType: m.orderType, limitPrice: m.limitPrice, triggerPrice: m.triggerPrice || 0 });
                if (o.orderType === 'LIMIT' && o.status === 'TRIGGER_PENDING') o.status = 'OPEN';
                checkNaked();
                return { brokerOrderId: id };
            },
            async cancelOrder(id) {
                auth(); const o = sim.orders.get(id); sim.calls.push({ op: 'cancel', id, side: o && o.side });
                if (!o || terminal(o)) return { brokerOrderId: id };
                if (o.side === 'BUY' && sim.entryFill === 'fillDuringCancel') { applyFill(o, o.quantity - o.filledQty, sim.ask); o.status = 'COMPLETE'; return { brokerOrderId: id }; }
                o.status = 'CANCELLED';
                checkNaked();
                return { brokerOrderId: id };
            },
            async getPositions() { auth(); return Object.entries(sim.pos).map(([k, p]) => ({ instrumentKey: k, symbol: p.symbol, netQty: p.netQty, avgEntryPrice: p.avg })); },
            async getAvailableMargin() { auth(); return sim.margin; },
            async getProfile() { auth(); return { user_id: 'SIM' }; }
        };
    };
    return sim;
}

function makeServer({ clock, kv = createKv(), sim = null, env = {}, runner = createFakeRunner(), publicIp = '203.0.113.7' } = {}) {
    const tg = [];
    sim = sim || createSimBroker(clock);
    const srv = serverMod.createEdgeServer({
        env: { WS_SECRET: 'test-secret-123456', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '42', EXPECTED_STATIC_IP: '203.0.113.7', TELEGRAM_WEBHOOK_SECRET: 'hook', ...env },
        getTime: clock.getTime, storageAdapter: kv, sleepFn: clock.sleep,
        telegramHttpSend: async (b, c, text) => { tg.push(text); return { status: 200, body: {} }; },
        getPublicIp: async () => publicIp, brokerClientFactory: sim.factory, runnerFactory: runner.factory
    });
    return { srv, tg, sim, kv, runner };
}

const sig = (id, ask, extra = {}) => ({
    signalId: id, levelId: `L${id}`, tier: 'A', side: 'BUY', level: 25000, quoteStatus: 'VERIFIED',
    quote: { ask, bid: ask - 0.2 }, contract: { symbol: SYMBOL, instrumentKey: IKEY }, ...extra
});
const tgMsg = (text, from = '42') => ({ message: { chat: { id: from }, from: { id: from }, text } });

async function runFullDayHeartbeats(srv, clock, day, { gapAt = null, from = [9, 15], to = [15, 31] } = {}) {
    clock.now = at(from[0], from[1], 0, day);
    const end = at(to[0], to[1], 0, day);
    while (clock.now <= end) {
        await srv.stepTime(clock.now);
        clock.now += (gapAt && Math.abs(clock.now - at(gapAt[0], gapAt[1], 0, day)) < 30000) ? 5 * 60000 : 60000;
    }
}

async function paperTrade(srv, clock, id, ask, exitBid) {
    const r = await srv.paperEngine.evaluateSignalForEntry(sig(id, ask));
    assert.strictEqual(r.status, 'OPENED', `entry ${id}: ${r.reason}`);
    await srv.onOptionQuote({ symbol: SYMBOL, bid: exitBid, ask: exitBid + 0.2 });
    return r;
}

// =============================================================== GOVERNOR / PAPER
test('Default stops (8/10/14) with ₹600 cap block a normal ATM entry (your trade-off decision is still open)', async () => {
    const clock = createClock(at(10, 0));
    const { srv } = makeServer({ clock });
    await srv.riskGovernor.armMode('PAPER');
    const r = await srv.paperEngine.evaluateSignalForEntry(sig('S1', 100));
    assert.strictEqual(r.status, 'BLOCKED'); assert.strictEqual(r.reason, 'INSUFFICIENT_DAILY_RISK_BUDGET');
});

test('Stop distances are config: tighter stops allow the same entry and change the plan version', async () => {
    const clock = createClock(at(10, 0));
    const { srv } = makeServer({ clock, env: TIGHT });
    await srv.riskGovernor.armMode('PAPER');
    const r = await srv.paperEngine.evaluateSignalForEntry(sig('S1', 100));
    assert.strictEqual(r.status, 'OPENED', r.reason);
    assert.strictEqual(r.position.plan.stopTriggerPrice, 95);
    assert.notStrictEqual(paperMod.planVersionId(paperMod.resolvePlanConfig({})), r.position.versionId);
});

test('Invalid stop config (trigger >= floor) refuses to start', async () => {
    assert.throws(() => paperMod.resolvePlanConfig({ stopTriggerOffsetRs: 10, stopLimitFloorOffsetRs: 8 }));
});

test('Pre-send gate: rejects market/bad qty/bad symbol/BUY-SL; allows exit identified by instrument key', async () => {
    const clock = createClock(at(10, 0));
    const audit = paperMod.createDecisionAuditLog(clock.getTime, null);
    const g = paperMod.createRiskGovernor({ getTime: clock.getTime, auditLog: audit, config: { stopTriggerOffsetRs: 5, stopLimitFloorOffsetRs: 6, stopChaserMaxSlippageRs: 7 } });
    const base = { side: 'BUY', orderType: 'LIMIT', quantity: 65, limitPrice: 100, symbol: SYMBOL };
    assert.strictEqual((await g.validatePreSendOrder({ ...base, orderType: 'MARKET' })).reason, 'MARKET_ORDER_FORBIDDEN');
    assert.strictEqual((await g.validatePreSendOrder({ ...base, quantity: 130 })).reason, 'INVALID_ORDER_QUANTITY');
    assert.strictEqual((await g.validatePreSendOrder({ ...base, symbol: 'BANKNIFTY' })).reason, 'INVALID_ORDER_INSTRUMENT');
    assert.strictEqual((await g.validatePreSendOrder({ ...base, orderType: 'SL', triggerPrice: 101 })).reason, 'ENTRY_MUST_BE_LIMIT');
    assert.strictEqual((await g.validatePreSendOrder({ side: 'SELL', orderType: 'LIMIT', quantity: 65, limitPrice: 90, symbol: 'NIFTY 25000 CE 03 NOV 26', instrumentKey: IKEY })).allowed, true);
    assert.strictEqual((await g.validatePreSendOrder({ side: 'SELL', orderType: 'SL', quantity: 65, limitPrice: 94, triggerPrice: 93, symbol: SYMBOL })).reason, 'INVALID_SL_TRIGGER');
});

test('Capital check uses the supplied funds (incl. charges) and fails closed if lookup fails', async () => {
    const clock = createClock(at(10, 0));
    const audit = paperMod.createDecisionAuditLog(clock.getTime, null);
    const mk = (fn) => paperMod.createRiskGovernor({ getTime: clock.getTime, auditLog: audit, getAvailableCapitalFn: fn, config: { stopTriggerOffsetRs: 5, stopLimitFloorOffsetRs: 6, stopChaserMaxSlippageRs: 7 } });
    const req = { side: 'BUY', orderType: 'LIMIT', quantity: 65, limitPrice: 100, symbol: SYMBOL };
    assert.strictEqual((await mk(async () => 6500).validatePreSendOrder(req)).reason, 'INSUFFICIENT_ACCOUNT_CAPITAL'); // 6500 premium + charges > 6500
    assert.strictEqual((await mk(async () => { throw new Error('down'); }).validatePreSendOrder(req)).reason, 'CAPITAL_LOOKUP_FAILED');
    assert.strictEqual((await mk(async () => 7000).validatePreSendOrder(req)).allowed, true);
});

test('Paper: stop, target and 30-min time stop exit via the quote/heartbeat path (15:15 EOD is a backstop: 14:45 cutoff + 30-min hold always exits first)', async () => {
    const clock = createClock(at(10, 0));
    const { srv } = makeServer({ clock, env: { ...TIGHT, MAX_TRADES_PER_DAY: '9', DAILY_LOSS_CAP_RS: '5000', MAX_WEEKLY_LOSS_RS: '9000' } });
    await srv.riskGovernor.armMode('PAPER');
    await paperTrade(srv, clock, 'A', 100, 95);                              // bid at trigger -> stop
    assert.strictEqual(srv.paperEngine.getCompletedTrades()[0].exitReason, 'STOP_LOSS_SL_TRIGGERED');
    await paperTrade(srv, clock, 'B', 100, 116.5);                           // target 116
    assert.strictEqual(srv.paperEngine.getCompletedTrades()[1].exitReason, 'TARGET_HIT_LIMIT');
    await paperTrade(srv, clock, 'C', 100, 101); clock.now += 31 * 60000;
    await srv.stepTime(clock.now);
    assert.strictEqual(srv.paperEngine.getCompletedTrades()[2].exitReason, 'TIME_STOP_30M_LIMIT');
    clock.now = at(14, 46);
    assert.strictEqual((await srv.paperEngine.evaluateSignalForEntry(sig('D', 100))).reason, 'AFTER_CUTOFF_1445');
});

test('Paper kill exits at the real bid, never the entry price; with no quote it refuses rather than invent a price', async () => {
    const clock = createClock(at(10, 0));
    const { srv } = makeServer({ clock, env: TIGHT });
    await srv.riskGovernor.armMode('PAPER');
    await srv.paperEngine.evaluateSignalForEntry(sig('K1', 100, { quote: { ask: 100 } }));  // no bid in signal
    let out = await srv.killEverything('TEST');
    assert.strictEqual(out.paper.refused, true);
    assert.ok(srv.paperEngine.getOpenPosition(), 'position kept, not faked closed');
    await srv.onOptionQuote({ symbol: SYMBOL, bid: 97, ask: 97.2 });
    out = await srv.killEverything('TEST');
    assert.strictEqual(out.paper.exitFillPrice, 96.5);
});

test('Feed verification is earned: clean full day verifies; gap, late start, health failure or early stop do not', async () => {
    const clock = createClock(at(9, 0));
    const { srv, runner } = makeServer({ clock });
    await runFullDayHeartbeats(srv, clock, 2);
    await runFullDayHeartbeats(srv, clock, 3, { gapAt: [11, 0] });
    await runFullDayHeartbeats(srv, clock, 4, { from: [9, 40] });
    runner.gaps = { X: 1 }; await runFullDayHeartbeats(srv, clock, 5); runner.gaps = {};
    await runFullDayHeartbeats(srv, clock, 6, { to: [14, 0] }); clock.now = at(15, 35, 0, 6); await srv.stepTime(clock.now);
    const v = (d) => srv.paperEngine.isSessionCleanAndVerified(`2026-11-0${d}`);
    assert.deepStrictEqual([v(2), v(3), v(4), v(5), v(6)], [true, false, false, false, false]);
});

test('Graduation gate counts only verified sessions on the current stop config', async () => {
    const clock = createClock(at(9, 0));
    const env = { ...TIGHT, MAX_TRADES_PER_DAY: '5' };
    const { srv } = makeServer({ clock, env });
    for (let day = 2; day <= 6; day++) {
        clock.now = at(9, 15, 0, day);
        await srv.riskGovernor.armMode('PAPER');
        let n = 0;
        while (clock.now <= at(15, 31, 0, day)) {
            await srv.stepTime(clock.now);
            const { minutesIst } = paperMod.getIstDateKeyAndMinutes(clock.now);
            if ((minutesIst === 10 * 60 || minutesIst === 11 * 60) && n < 2) { await paperTrade(srv, clock, `G${day}${n}`, 100, 116.5); n++; }
            clock.now += 60000;
        }
    }
    const g = srv.paperEngine.canArmLive();
    assert.strictEqual(g.allowed, true, g.reason);
    assert.strictEqual(g.sessionsCount, 5); assert.strictEqual(g.tradesCount, 10);
    const ev = srv.paperEngine.getGraduationEvidence();
    assert.strictEqual(ev.sessions.length, 5);
});

test('Restart: daily loss tally, trade count and paper trades survive; mode comes back SHADOW', async () => {
    const clock = createClock(at(10, 0));
    const kv = createKv();
    const a = makeServer({ clock, kv, env: TIGHT });
    await a.srv.riskGovernor.armMode('PAPER');
    await paperTrade(a.srv, clock, 'R1', 100, 95);
    await a.srv.flushPersistence();
    const before = a.srv.riskGovernor.getStateSnapshot().today;
    const b = makeServer({ clock, kv, env: TIGHT });
    await b.srv.boot();
    const after = b.srv.riskGovernor.getStateSnapshot();
    assert.strictEqual(after.mode, 'SHADOW');
    assert.strictEqual(after.today.realizedNetPnl, before.realizedNetPnl);
    assert.strictEqual(after.today.tradeCount, 1);
    assert.strictEqual(b.srv.paperEngine.getCompletedTrades().length, 1);
});

test('Restart cannot reset the daily loss cap', async () => {
    const clock = createClock(at(10, 0));
    const kv = createKv();
    const env = { ...TIGHT, DAILY_LOSS_CAP_RS: '800', MAX_TRADES_PER_DAY: '5' };
    const a = makeServer({ clock, kv, env });
    await a.srv.riskGovernor.armMode('PAPER');
    await paperTrade(a.srv, clock, 'L1', 100, 94);     // ~ -₹450 incl charges
    await a.srv.flushPersistence();
    const b = makeServer({ clock, kv, env });
    await b.srv.boot();
    await b.srv.riskGovernor.armMode('PAPER');
    const r = await b.srv.paperEngine.evaluateSignalForEntry(sig('L2', 100));
    assert.strictEqual(r.status, 'BLOCKED'); assert.strictEqual(r.reason, 'INSUFFICIENT_DAILY_RISK_BUDGET');
});

test('Clearing a kill keeps loss history; clearing a multi-day halt keeps history too', async () => {
    const clock = createClock(at(16, 0, 0, 2));
    const audit = paperMod.createDecisionAuditLog(clock.getTime, null);
    const g = paperMod.createRiskGovernor({ getTime: clock.getTime, auditLog: audit });
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04']) await g.recordCompletedDaySummary(d, -100);
    assert.ok(g.getStateSnapshot().multiDayHaltReason);
    await g.triggerEmergencyKill('t'); await g.clearEmergencyKill();
    assert.strictEqual(g.getStateSnapshot().completedDays.length, 3);
    assert.ok(g.getStateSnapshot().multiDayHaltReason, 'kill clear must not lift multi-day halt');
    await g.clearMultiDayHalt('CLEAR-HELL-MULTIDAY-HALT');
    assert.strictEqual(g.getStateSnapshot().completedDays.length, 3, 'history kept');
    assert.strictEqual(g.getStateSnapshot().multiDayHaltReason, null);
    await assert.rejects(() => g.clearMultiDayHalt('wrong'));
});

test('Storage missing or failing blocks new entries (fail closed) and warns', async () => {
    const clock = createClock(at(10, 0));
    const noKv = makeServer({ clock, kv: { appendDecisionAudit: async () => {} }, env: TIGHT });
    await noKv.srv.riskGovernor.armMode('PAPER');
    assert.strictEqual((await noKv.srv.paperEngine.evaluateSignalForEntry(sig('P1', 100))).reason, 'STORAGE_PERSISTENCE_FAILED');
    const kv = createKv();
    const f = makeServer({ clock, kv, env: TIGHT });
    kv.failWrites = true;
    await f.srv.riskGovernor.armMode('PAPER');
    await f.srv.flushPersistence();
    assert.strictEqual((await f.srv.paperEngine.evaluateSignalForEntry(sig('P2', 100))).reason, 'STORAGE_PERSISTENCE_FAILED');
    assert.ok(f.tg.some(t => t.includes('PERSISTENCE_FAILED')));
});

test('Days missed while the server was down are finalised on boot (multi-day breaker sees them)', async () => {
    const clock = createClock(at(10, 0, 0, 2));
    const kv = createKv();
    const a = makeServer({ clock, kv, env: TIGHT });
    await a.srv.riskGovernor.armMode('PAPER');
    await paperTrade(a.srv, clock, 'D1', 100, 95);
    await a.srv.flushPersistence();
    clock.now = at(9, 0, 0, 3);
    const b = makeServer({ clock, kv, env: TIGHT });
    await b.srv.boot();
    const days = b.srv.riskGovernor.getStateSnapshot().completedDays;
    assert.strictEqual(days.length, 1); assert.strictEqual(days[0].dateKey, '2026-11-02');
});

// =============================================================== LIVE (simulated broker)
async function liveReady(opts = {}) {
    const clock = createClock(at(10, 0));
    const sim = createSimBroker(clock, opts.sim || {});
    const ctx = makeServer({ clock, sim, env: { ...TIGHT, ...(opts.env || {}) }, kv: opts.kv });
    await ctx.srv.completeLogin('tok-1');
    await ctx.srv.riskGovernor.armMode('PAPER');            // governor only needs a non-shadow mode for entry checks
    return { clock, ...ctx };
}

test('Live entry: fill read from order status, SL placed from actual fill price', async () => {
    const { srv, sim } = await liveReady();
    const r = await srv.liveManager.executeSignalEntry(sig('E1', 100));
    assert.strictEqual(r.status, 'OPENED', r.reason);
    assert.strictEqual(r.position.qty, 65);
    const slPlace = sim.calls.find(c => c.op === 'place' && c.orderType === 'SL');
    assert.deepStrictEqual([slPlace.qty, slPlace.triggerPrice, slPlace.limitPrice], [65, 95.2, 94.2]);
    assert.strictEqual(sim.orders.get(r.position.slOrderId).status, 'TRIGGER_PENDING');
});

test('Live entry never fills: cancelled, no position, no SL', async () => {
    const { srv, sim } = await liveReady({ sim: { entryFill: 'never' } });
    const r = await srv.liveManager.executeSignalEntry(sig('E2', 100));
    assert.strictEqual(r.status, 'UNFILLED');
    assert.strictEqual(srv.liveManager.getActivePosition(), null);
    assert.ok(!sim.calls.some(c => c.orderType === 'SL'));
});

test('Live entry fills DURING the cancel: position recorded and protected', async () => {
    const { srv, sim } = await liveReady({ sim: { entryFill: 'fillDuringCancel' } });
    const r = await srv.liveManager.executeSignalEntry(sig('E3', 100));
    assert.strictEqual(r.status, 'OPENED');
    assert.strictEqual(sim.calls.filter(c => c.op === 'place' && c.orderType === 'SL')[0].qty, 65);
});

test('Live partial fill: remainder cancelled, SL covers exactly the filled qty', async () => {
    const { srv, sim } = await liveReady({ sim: { entryFill: 'partial', partialQty: 25 } });
    const r = await srv.liveManager.executeSignalEntry(sig('E4', 100));
    assert.strictEqual(r.status, 'OPENED');
    assert.strictEqual(r.position.qty, 25);
    assert.strictEqual(sim.calls.find(c => c.orderType === 'SL').qty, 25);
});

test('Live SL rejected by broker: position exited immediately and alerted', async () => {
    const { srv, sim, tg } = await liveReady({ sim: { slReject: true } });
    const r = await srv.liveManager.executeSignalEntry(sig('E5', 100));
    assert.strictEqual(r.status, 'FLATTENED_ON_SL_FAILURE');
    assert.strictEqual(sim.pos[IKEY].netQty, 0);
    assert.ok(tg.some(t => t.includes('SL REJECTED')));
});

test('Kill with live position: SL converted in place to a chasing exit — never a moment without a resting sell', async () => {
    const { srv, sim } = await liveReady();
    await srv.liveManager.executeSignalEntry(sig('K2', 100));
    sim.watchNaked = true;
    sim.bid = 97;
    await srv.onOptionQuote({ symbol: SYMBOL, bid: 97, ask: 97.2 });
    const out = await srv.killEverything('TEST');
    assert.strictEqual(out.live.closed, true, JSON.stringify(out.live));
    assert.strictEqual(sim.pos[IKEY].netQty, 0);
    assert.strictEqual(sim.nakedObserved, 0);
    assert.ok(!sim.calls.some(c => c.op === 'cancel' && c.side === 'SELL'), 'SL was not cancelled');
    assert.strictEqual(srv.riskGovernor.getStateSnapshot().emergencyHalted, true);
    assert.ok(srv.riskGovernor.getStateSnapshot().today.realizedNetPnl < 0);
});

test('Kill when broker refuses SL->LIMIT modify: cancel is CONFIRMED before a separate exit is placed', async () => {
    const { srv, sim } = await liveReady({ sim: { allowSlToLimit: false } });
    await srv.liveManager.executeSignalEntry(sig('K3', 100));
    sim.bid = 98;
    const out = await srv.killEverything('TEST');
    assert.strictEqual(out.live.closed, true);
    const idxCancel = sim.calls.findIndex(c => c.op === 'cancel' && c.side === 'SELL');
    const idxExit = sim.calls.findIndex((c, i) => i > idxCancel && c.op === 'place' && c.side === 'SELL' && c.orderType === 'LIMIT');
    assert.ok(idxCancel >= 0 && idxExit > idxCancel);
    assert.strictEqual(sim.pos[IKEY].netQty, 0);
});

test('Broker-side SL fill is detected on the heartbeat and booked', async () => {
    const { srv, sim, clock } = await liveReady();
    await srv.liveManager.executeSignalEntry(sig('S2', 100));
    sim.bid = 95;                                   // through trigger 95.2, above limit 94.2
    await srv.stepTime(clock.now += 1000);
    assert.strictEqual(srv.liveManager.getActivePosition(), null);
    assert.strictEqual(srv.liveManager.getCompletedLiveTrades()[0].exitReason, 'BROKER_SL_FILLED');
});

test('SL triggered but unfilled (gap below limit): chaser exits after 2s', async () => {
    const { srv, sim, clock } = await liveReady();
    await srv.liveManager.executeSignalEntry(sig('S3', 100));
    sim.bid = 90;                                    // below SL limit 94.2 -> triggered, unfilled
    await srv.onOptionQuote({ symbol: SYMBOL, bid: 90, ask: 90.2 });
    await srv.stepTime(clock.now += 500);
    assert.ok(srv.liveManager.getActivePosition());
    await srv.stepTime(clock.now += 2500);
    assert.strictEqual(srv.liveManager.getActivePosition(), null);
    assert.strictEqual(srv.liveManager.getCompletedLiveTrades()[0].exitReason, 'SL_TRIGGERED_UNFILLED_CHASE');
});

test('Live target and 30-min time stop exit on the heartbeat', async () => {
    const { srv, sim, clock } = await liveReady({ env: { MAX_TRADES_PER_DAY: '5' } });
    await srv.liveManager.executeSignalEntry(sig('T1', 100));
    sim.bid = 117; await srv.onOptionQuote({ symbol: SYMBOL, bid: 117, ask: 117.2 });
    await srv.stepTime(clock.now += 1000);
    assert.strictEqual(srv.liveManager.getCompletedLiveTrades()[0].exitReason, 'TARGET_HIT');
    sim.bid = 100; sim.ask = 100.2;
    await srv.liveManager.executeSignalEntry(sig('T2', 100));
    sim.bid = 101; await srv.onOptionQuote({ symbol: SYMBOL, bid: 101, ask: 101.2 });
    await srv.stepTime(clock.now += 31 * 60000);
    assert.strictEqual(srv.liveManager.getCompletedLiveTrades()[1].exitReason, 'TIME_STOP_30M');
});

test('401 mid-session: LIVE disarmed, alert sent, resting SL left alone; /login gives the SAME manager a working token', async () => {
    const { srv, sim, tg, clock } = await liveReady();
    await srv.liveManager.executeSignalEntry(sig('A1', 100));
    await srv.riskGovernor.confirmLiveArmOnTelegram();
    await srv.riskGovernor.armMode('LIVE', 'T', { allowed: true });
    sim.forceAuthFail = true;
    await srv.stepTime(clock.now += 1000);
    assert.strictEqual(srv.riskGovernor.getStateSnapshot().mode, 'SHADOW');
    assert.ok(tg.some(t => t.includes('BROKER_TOKEN_INVALID')));
    assert.ok(!sim.calls.some(c => c.op === 'cancel'));
    assert.ok([...sim.orders.values()].some(o => o.orderType === 'SL' && o.status === 'TRIGGER_PENDING'));
    sim.forceAuthFail = false;
    await srv.completeLogin('tok-2');
    sim.bid = 95; await srv.stepTime(clock.now += 1000);
    assert.strictEqual(sim.tokenSeen[sim.tokenSeen.length - 1], 'tok-2');
    assert.strictEqual(srv.liveManager.getActivePosition(), null);
});

test('Live entry blocked without an Upstox instrument key', async () => {
    const { srv } = await liveReady();
    const r = await srv.liveManager.executeSignalEntry(sig('I1', 100, { contract: { symbol: SYMBOL } }));
    assert.strictEqual(r.reason, 'MISSING_UPSTOX_INSTRUMENT_KEY');
});

test('Kill during an in-flight entry ends flat', async () => {
    const { srv, sim } = await liveReady({ sim: { entryFill: 'fillDuringCancel' } });
    let kill = null;
    sim.onBuyPlaced = () => { kill = srv.killEverything('TEST'); };   // kill lands while entry is polling
    const entry = await srv.liveManager.executeSignalEntry(sig('KF', 100));
    await kill;
    assert.strictEqual(entry.status, 'FLATTENED_ON_KILL');
    assert.strictEqual(sim.pos[IKEY].netQty, 0);
    assert.strictEqual(srv.liveManager.getActivePosition(), null);
});

test('Arm-live gate: IP, login, reconcile, graduation and Telegram confirm are each enforced', async () => {
    const clock = createClock(at(10, 0));
    const sim = createSimBroker(clock);
    const bad = makeServer({ clock, sim, publicIp: '198.51.100.1' });
    assert.match((await bad.srv.armLiveWithChecks('T')).error, /does not match/);
    const ctx = makeServer({ clock, sim, env: TIGHT });
    assert.match((await ctx.srv.armLiveWithChecks('T')).error, /not logged in/);
    await ctx.srv.completeLogin('tok');
    sim.pos['NSE_FO|999'] = { netQty: 65, avg: 50, symbol: 'X' };           // stray position
    assert.strictEqual((await ctx.srv.armLiveWithChecks('T')).code, 409);
    delete sim.pos['NSE_FO|999'];
    await ctx.srv.handleTelegramUpdate(tgMsg('/reconcile'));
    assert.match((await ctx.srv.armLiveWithChecks('T')).error, /feed-verified sessions/);
});

test('Arm-live succeeds only when everything passes (graduated paper history + /confirm-live)', async () => {
    const clock = createClock(at(9, 0));
    const sim = createSimBroker(clock);
    const env = { ...TIGHT, MAX_TRADES_PER_DAY: '5' };
    const { srv } = makeServer({ clock, sim, env });
    for (let day = 2; day <= 6; day++) {
        clock.now = at(9, 15, 0, day);
        await srv.riskGovernor.armMode('PAPER');
        let n = 0;
        while (clock.now <= at(15, 31, 0, day)) {
            await srv.stepTime(clock.now);
            const { minutesIst } = paperMod.getIstDateKeyAndMinutes(clock.now);
            if ((minutesIst === 600 || minutesIst === 660) && n < 2) { await paperTrade(srv, clock, `Z${day}${n}`, 100, 116.5); n++; }
            clock.now += 60000;
        }
    }
    clock.now = at(9, 30, 0, 9);
    await srv.completeLogin('tok');
    assert.match((await srv.armLiveWithChecks('T')).error, /TELEGRAM_CONFIRMATION/);
    await srv.handleTelegramUpdate(tgMsg('/confirm-live'));
    const r = await srv.armLiveWithChecks('T');
    assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.mode, 'LIVE');
});

test('Restart with an open live position: boots SHADOW, adopts position and its resting SL after login, no duplicate SL', async () => {
    const kv = createKv();
    const { srv, sim, clock } = await liveReady({ kv });
    await srv.liveManager.executeSignalEntry(sig('B1', 100));
    await srv.flushPersistence();
    const slCount = sim.calls.filter(c => c.orderType === 'SL').length;
    const b = makeServer({ clock, sim, kv, env: TIGHT });
    await b.srv.boot();
    assert.strictEqual(b.srv.riskGovernor.getStateSnapshot().mode, 'SHADOW');
    assert.ok(b.tg.some(t => t.includes('was open before restart')));
    const r = await b.srv.completeLogin('tok-b');
    assert.strictEqual(r.boot.status, 'RESUMED_OPEN_POSITION'); assert.strictEqual(r.recon.matched, true);
    assert.strictEqual(sim.calls.filter(c => c.orderType === 'SL').length, slCount);
});

test('Restart finds broker position with no SL: places one', async () => {
    const clock = createClock(at(10, 0));
    const sim = createSimBroker(clock);
    sim.pos[IKEY] = { netQty: 65, avg: 100, symbol: SYMBOL };
    const { srv } = makeServer({ clock, sim, env: TIGHT });
    await srv.boot();
    const r = await srv.completeLogin('tok');
    assert.strictEqual(r.boot.status, 'RESUMED_OPEN_POSITION');
    const sl = sim.calls.find(c => c.orderType === 'SL');
    assert.deepStrictEqual([sl.qty, sl.triggerPrice], [65, 95]);
});

test('Telegram: unknown sender ignored; HTTP webhook needs secret; admin brute force locks out', async () => {
    const clock = createClock(at(10, 0));
    const { srv } = makeServer({ clock });
    assert.strictEqual((await srv.handleTelegramUpdate(tgMsg('/kill', '999'))).reason, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(srv.riskGovernor.getStateSnapshot().emergencyHalted, false);
    await new Promise(r => srv.httpServer.listen(0, r));
    const port = srv.httpServer.address().port;
    const call = (p, opt = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: JSON.stringify(opt.body || {}) });
    assert.strictEqual((await call('/telegram/webhook', { body: tgMsg('/kill') })).status, 401);
    let last;
    for (let i = 0; i < 5; i++) last = await call('/admin/kill', { headers: { authorization: 'Bearer wrong' } });
    assert.strictEqual(last.status, 429);
    assert.strictEqual((await call('/admin/kill', { headers: { authorization: 'Bearer test-secret-123456' } })).status, 429, 'still locked');
    srv.wss.close(); await new Promise(r => srv.httpServer.close(r));
});

test('Upstox OAuth callback: state is required and single-use', async () => {
    const clock = createClock(at(10, 0));
    const { srv } = makeServer({ clock, env: { UPSTOX_CLIENT_ID: 'cid', UPSTOX_REDIRECT_URI: 'https://hell.example/upstox/callback' } });
    await new Promise(r => srv.httpServer.listen(0, r));
    const port = srv.httpServer.address().port;
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/upstox/callback?code=x&state=forged`)).status, 400);
    await srv.handleTelegramUpdate(tgMsg('/login'));
    assert.strictEqual(srv._oauthStateCount(), 1);
    srv.wss.close(); await new Promise(r => srv.httpServer.close(r));
});


// =============================================================== STAGE 5 (exit safety, entrypoint, runner)
const STAGE5 = { STOP_TRIGGER_OFFSET_RS: '6', STOP_LIMIT_FLOOR_OFFSET_RS: '7.5', STOP_CHASER_MAX_SLIPPAGE_RS: '9', DAILY_LOSS_CAP_RS: '700', PER_TRADE_RISK_RS: '460', MAX_TRADES_PER_DAY: '1', MAX_WEEKLY_LOSS_RS: '1400' };

test('Stage 5: locked config (6/7.5/9, cap 700) lets a normal ATM entry through', async () => {
    const { srv } = await liveReady({ env: STAGE5 });
    const r = await srv.liveManager.executeSignalEntry(sig('C1', 100));
    assert.strictEqual(r.status, 'OPENED', r.reason);
    assert.deepStrictEqual([r.position.stopTriggerPrice, r.position.stopLimitPrice], [94.2, 92.7]);
});

test('Stage 5: chaser not filled in time escalates until flat (no MARKET order), books the real loss, and the cap halts the day', async () => {
    const { srv, sim, clock, tg } = await liveReady({ env: STAGE5 });
    await srv.liveManager.executeSignalEntry(sig('U1', 100));
    // Fast market: HELL's last quote says 80, but the real book is only bidding 70 (below every planned stop level).
    sim.bid = 80; sim.bidLevels = [{ price: 70, qty: 1000 }];
    await srv.onOptionQuote({ symbol: SYMBOL, bid: 80, ask: 80.2 });
    await srv.stepTime(clock.now += 1000);                  // SL triggers, its limit (92.7) can't fill
    assert.ok(srv.liveManager.getActivePosition());
    const chaseStart = clock.now += 2500;
    await srv.stepTime(chaseStart);                         // 2 s later: SL becomes a chasing exit
    assert.strictEqual(srv.liveManager.getActivePosition(), null, 'must end flat');
    assert.strictEqual(sim.pos[IKEY].netQty, 0);
    assert.ok(clock.now - chaseStart <= 6000, `flat ${clock.now - chaseStart} ms after the chase began`);
    assert.ok(!sim.calls.some(c => c.orderType === 'MARKET'));
    const t = srv.liveManager.getCompletedLiveTrades()[0];
    assert.strictEqual(t.exitPrice, 70);
    const snap = srv.riskGovernor.getStateSnapshot().today;
    assert.ok(snap.realizedNetPnl < -700, `real loss ${snap.realizedNetPnl} is beyond the plan's worst case and is what gets booked`);
    assert.strictEqual(snap.haltedReason, 'HALTED_DAILY_LOSS');
    assert.ok(tg.filter(x => x.includes('EXIT ESCALATING')).length >= 2, 'every escalation alerts');
    assert.strictEqual((await srv.liveManager.executeSignalEntry(sig('U2', 100))).status, 'BLOCKED');
});

test('Stage 5: chaser partly filled -> the remaining quantity is escalated and closed; P&L uses the average of both fills', async () => {
    const { srv, sim } = await liveReady({ env: STAGE5 });
    await srv.liveManager.executeSignalEntry(sig('P1', 100));
    sim.bid = 85; sim.bidLevels = [{ price: 85, qty: 25 }, { price: 80, qty: 1000 }];
    const res = await srv.liveManager.killAll('TEST', 85);
    assert.strictEqual(res.closed, true, JSON.stringify(res));
    assert.strictEqual(sim.pos[IKEY].netQty, 0);
    const t = srv.liveManager.getCompletedLiveTrades()[0];
    assert.strictEqual(t.qty, 65);
    assert.strictEqual(t.exitPrice, +((25 * 85 + 40 * 80) / 65).toFixed(2));
});

test('Stage 5: exit part-filled then cancelled by the exchange -> a new exit closes the rest; nothing is double-sold', async () => {
    const { srv, sim } = await liveReady({ env: STAGE5 });
    await srv.liveManager.executeSignalEntry(sig('P2', 100));
    sim.bid = 85; sim.bidLevels = [{ price: 85, qty: 25 }, { price: 80, qty: 1000 }]; sim.cancelSellAfterPartial = true;
    const res = await srv.liveManager.killAll('TEST', 85);
    assert.strictEqual(res.closed, true, JSON.stringify(res));
    assert.strictEqual(sim.pos[IKEY].netQty, 0);
    const sells = sim.calls.filter(c => c.op === 'place' && c.side === 'SELL' && c.orderType === 'LIMIT');
    assert.deepStrictEqual(sells.map(c => c.qty), [40]);
    const t = srv.liveManager.getCompletedLiveTrades()[0];
    assert.strictEqual(t.qty, 65);
    assert.strictEqual(t.exitPrice, +((25 * 85 + 40 * 80) / 65).toFixed(2));
});

test('Stage 5: instrument master unavailable -> download fails loudly, no order is placed, alert raised', async () => {
    await assert.rejects(() => entrypoint.fetchUpstoxInstrumentMaster(async () => ({ ok: false, status: 500 }), 'https://x/NSE.json'), /HTTP 500/);
    const clock = createClock(at(10, 0));
    const sim = createSimBroker(clock);
    const feed = runnerMod.createSimulatedFeed('UPSTOX');
    const runner = { factory: (opts) => runnerMod.createRunner({ ...opts, feeds: [feed], config: { ...opts.config, instrumentKeyResolver: () => { throw new Error('master down'); } } }) };
    const { srv, tg } = makeServer({ clock, sim, env: STAGE5, runner });
    await srv.boot();
    await feed.emitRawTick({ kind: 'spot', ltp: 25010, ts: clock.now });
    await srv.completeLogin('tok');
    await srv.riskGovernor.armMode('PAPER');
    const r = await srv.liveManager.executeSignalEntry(sig('M1', 100, { contract: { symbol: SYMBOL } }));
    assert.strictEqual(r.reason, 'MISSING_UPSTOX_INSTRUMENT_KEY');
    assert.ok(!sim.calls.some(c => c.op === 'place'));
    assert.ok(tg.some(t => t.includes('NO ORDER')));
});

test('Stage 5: unknown contract -> blocked, no order reaches the broker', async () => {
    const { srv, sim } = await liveReady({ env: STAGE5 });
    const r = await srv.liveManager.executeSignalEntry(sig('X1', 100, { contract: { symbol: 'NIFTY26N0399999CE', instrumentKey: null } }));
    assert.strictEqual(r.status, 'BLOCKED');
    assert.ok(!sim.calls.some(c => c.op === 'place'));
});

test('Stage 5: overlapping heartbeat -> the second tick does not run alongside the first', async () => {
    const clock = createClock(at(10, 0));
    let running = 0, maxRunning = 0;
    const slow = { factory: () => ({
        getGapLedger: () => ({ getOpenGaps: () => ({}) }), getFailoverManager: () => ({ getSource: () => 'FYERS' }),
        getPersistenceHealth: () => ({ currentlyFailed: false }), boot: async () => {},
        stepTime: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise(r => setTimeout(r, 50)); running--; }
    }) };
    const { srv } = makeServer({ clock, runner: slow });
    const [a, b] = await Promise.all([srv.stepTime(clock.now), srv.stepTime(clock.now)]);
    assert.strictEqual(maxRunning, 1);
    assert.ok((a && a.skipped) || (b && b.skipped));
});

test('Stage 5: shutdown with an open position -> state saved, stop left resting, nothing cancelled', async () => {
    const { srv, sim, kv, tg } = await liveReady({ env: STAGE5 });
    await srv.liveManager.executeSignalEntry(sig('S1', 100));
    const pos = srv.liveManager.getActivePosition();
    const callsBefore = sim.calls.length;
    const out = await entrypoint.shutdownGracefully({ edgeServer: srv, signal: 'SIGTERM' });
    assert.strictEqual(out.liveOpen, true);
    assert.strictEqual(sim.calls.length, callsBefore, 'shutdown must not touch orders');
    assert.strictEqual(sim.orders.get(pos.slOrderId).status, 'TRIGGER_PENDING');
    assert.strictEqual(JSON.parse(kv.data.hell_live_state).position.slOrderId, pos.slOrderId);
    assert.ok(tg.some(t => t.includes('stays resting')));
});

test('Stage 5: runner - KV save/load round-trip, option-quote forwarding, instrument-key resolution, data gaps', async () => {
    const store = {};
    const pool = { query: async (sql, params) => {
        if (sql.includes('INSERT INTO edge_kv')) { store[params[0]] = params[1]; return { rows: [] }; }
        if (sql.includes('SELECT value FROM edge_kv')) return { rows: store[params[0]] !== undefined ? [{ value: store[params[0]] }] : [] };
        return { rows: [] };
    } };
    const adapter = runnerMod.createPgStorageAdapter(pool);
    await adapter.saveKv('k', '{"a":1}');
    assert.strictEqual(await adapter.loadKv('k'), '{"a":1}');
    assert.strictEqual(await adapter.loadKv('missing'), null);

    const clock = createClock(at(10, 0));
    const feed = runnerMod.createSimulatedFeed('FYERS');
    const quotes = [], warnings = [];
    const runner = runnerMod.createRunner({ getTime: clock.getTime, storageAdapter: adapter, feeds: [feed],
        config: { instrumentKeys: { [SYMBOL]: IKEY } }, onOptionQuote: async (q) => quotes.push(q), onWarning: async (w) => warnings.push(w.type) });
    await runner.boot();
    assert.strictEqual(runner.resolveInstrumentKey(SYMBOL), IKEY);
    assert.strictEqual(runner.resolveInstrumentKey('NIFTY26N0399999CE'), null);
    await feed.emitRawTick({ kind: 'option', sym: SYMBOL, ts: clock.now, ltp: 100, b: 99.8, a: 100.2 });
    assert.deepStrictEqual([quotes[0].symbol, quotes[0].bid, quotes[0].ask], [SYMBOL, 99.8, 100.2]);
    assert.strictEqual(runner.getFailoverManager().getSource(), 'FYERS');
    clock.now += 30000;                                   // feed goes quiet in market hours
    await runner.stepTime(clock.now);
    assert.ok(Object.keys(runner.getGapLedger().getOpenGaps()).length > 0);
    assert.strictEqual(runner.getFailoverManager().getSource(), 'UNKNOWN');
    await feed.emitRawTick({ kind: 'spot', ltp: 25000, ts: clock.now });
    await runner.stepTime(clock.now);
    assert.deepStrictEqual(runner.getGapLedger().getOpenGaps(), {});
    assert.ok(warnings.includes('DATA_GAP') && warnings.includes('DATA_RECOVERED'));
});

test('Stage 5: daily instrument map - weekly and monthly NIFTY symbols resolve to Upstox keys; wrong lot size refuses', () => {
    const ist = (y, m, d) => Date.UTC(y, m, d, 9, 30) - IST;    // 15:30 IST expiry stamp
    const rows = [
        { segment: 'NSE_FO', name: 'NIFTY', instrument_type: 'CE', strike_price: 25000, expiry: ist(2026, 10, 3), lot_size: 65, instrument_key: 'NSE_FO|1', trading_symbol: 'NIFTY 25000 CE 03 NOV 26' },
        { segment: 'NSE_FO', name: 'NIFTY', instrument_type: 'PE', strike_price: 24950, expiry: ist(2026, 10, 24), lot_size: 65, instrument_key: 'NSE_FO|2', trading_symbol: 'NIFTY 24950 PE 24 NOV 26' },
        { segment: 'NSE_FO', name: 'BANKNIFTY', instrument_type: 'CE', strike_price: 52000, expiry: ist(2026, 10, 24), lot_size: 30, instrument_key: 'NSE_FO|3' }
    ];
    const { map } = entrypoint.buildNiftyKeyMap(rows);
    assert.strictEqual(map.NIFTY26N0325000CE, 'NSE_FO|1');
    assert.strictEqual(map.NIFTY26NOV24950PE, 'NSE_FO|2');
    assert.strictEqual(map['NIFTY 25000 CE 03 NOV 26'], 'NSE_FO|1');
    assert.ok(!Object.values(map).includes('NSE_FO|3'));
    assert.ok(paperMod.NIFTY_OPT_SYMBOL_REGEX.test('NIFTY26NOV24950PE') && paperMod.NIFTY_OPT_SYMBOL_REGEX.test('NIFTY26N0325000CE'));
    assert.throws(() => entrypoint.buildNiftyKeyMap([{ ...rows[0], lot_size: 75 }]), /lot size/);
});

test('Stage 5: startup refuses a bad config with a clear message', () => {
    const problems = entrypoint.checkConfig({ WS_SECRET: 'short', UPSTOX_REDIRECT_URI: 'http://x', STOP_TRIGGER_OFFSET_RS: '9', STOP_LIMIT_FLOOR_OFFSET_RS: '7' });
    assert.ok(problems.includes('missing DATABASE_URL'));
    assert.ok(problems.some(p => /WS_SECRET/.test(p)) && problems.some(p => /https/.test(p)) && problems.some(p => /trigger < limit floor/.test(p)));
});


// =============================================================== UPSTOX MARKET FEED (local fake Upstox WebSocket)
const feedMod = require('./upstox_feed.js');
const { WebSocketServer } = require('ws');

async function waitFor(cond, ms = 3000, label = 'condition') {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await new Promise(r => setTimeout(r, 10)); }
}

// Fake Upstox feed server: records auth headers and subscribe messages, lets the test push protobuf frames.
async function fakeUpstoxFeedServer() {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise(r => wss.on('listening', r));
    const f = { wss, url: `ws://127.0.0.1:${wss.address().port}`, conns: [], auths: [], subs: [] };
    wss.on('connection', (sock, req) => {
        f.conns.push(sock); f.auths.push(req.headers.authorization);
        sock.on('message', (m) => f.subs.push(JSON.parse(String(m))));
    });
    f.push = (obj) => f.conns[f.conns.length - 1].send(feedMod.encodeFeedResponse(obj));
    f.subscribedKeys = () => new Set(f.subs.flatMap(x => x.data.instrumentKeys));
    f.close = () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(r); });
    return f;
}

const IST_MS = (y, m, d, hh, mm) => Date.UTC(y, m, d, hh, mm) - IST;
function feedContracts() {
    const out = [];
    for (const [expiryMs, tag] of [[IST_MS(2026, 10, 3, 15, 30), 'N03'], [IST_MS(2026, 10, 10, 15, 30), 'N10']]) {
        for (let k = 24000; k <= 26000; k += 50) for (const type of ['CE', 'PE']) {
            out.push({ symbol: `NIFTY26${tag}${k}${type}`, instrumentKey: `NSE_FO|${tag}${k}${type}`, strike: k, type, expiryMs });
        }
    }
    return out;
}
const idxFrame = (ltp, ltt) => ({ type: 'live_feed', feeds: { [feedMod.NIFTY_INDEX_KEY]: { fullFeed: { indexFF: { ltpc: { ltp, ltt } } } } } });
const optFrame = (key, ltp, bid, ask, ltt) => ({ type: 'live_feed', feeds: { [key]: { fullFeed: { marketFF: { ltpc: { ltp, ltt }, marketLevel: { bidAskQuote: bid ? [{ bidP: bid, bidQ: 650, askP: ask, askQ: 650 }] : [] } } } } } });

test('Upstox feed: waits for today\'s login, then connects with the Bearer token and subscribes the NIFTY index (full mode)', async () => {
    const fake = await fakeUpstoxFeedServer();
    const clock = createClock(at(10, 0));
    let token = null;
    const feed = feedMod.createUpstoxMarketFeed({ url: fake.url, getAccessToken: () => token, getContracts: feedContracts, getTime: clock.getTime, watchMs: 1e9 });
    try {
        await feed.start();
        await new Promise(r => setTimeout(r, 100));
        assert.strictEqual(fake.conns.length, 0, 'no connection before /login');
        token = 'TOK-1'; feed._watch();
        await waitFor(() => fake.subs.length >= 1, 3000, 'subscribe');
        assert.strictEqual(fake.auths[0], 'Bearer TOK-1');
        assert.deepStrictEqual([fake.subs[0].method, fake.subs[0].data.mode, fake.subs[0].data.instrumentKeys], ['sub', 'full', ['NSE_INDEX|Nifty 50']]);
    } finally { await feed.stop(); await fake.close(); }
});

test('Upstox feed: index price -> spot tick; subscribes nearest-expiry ATM ±10 strikes; option depth -> option tick with bid/ask', async () => {
    const fake = await fakeUpstoxFeedServer();
    const clock = createClock(at(10, 0));
    const ticks = [];
    const feed = feedMod.createUpstoxMarketFeed({ url: fake.url, getAccessToken: () => 'T', getContracts: feedContracts, getTime: clock.getTime, watchMs: 1e9 });
    feed.onTick(async (t) => ticks.push(t));
    try {
        await feed.start();
        await waitFor(() => fake.subs.length >= 1);
        fake.push(idxFrame(25012.4, clock.now));
        await waitFor(() => ticks.length >= 1 && fake.subscribedKeys().size > 1);
        assert.deepStrictEqual([ticks[0].kind, ticks[0].ltp, ticks[0].src], ['spot', 25012.4, 'UPSTOX']);
        const keys = [...fake.subscribedKeys()].filter(k => k.startsWith('NSE_FO'));
        assert.strictEqual(keys.length, 42);
        assert.ok(keys.every(k => k.includes('N03')), 'only the nearest expiry');
        assert.ok(keys.includes('NSE_FO|N0325000CE') && keys.includes('NSE_FO|N0324500PE') && keys.includes('NSE_FO|N0325500CE') && !keys.includes('NSE_FO|N0325550CE'));
        fake.push(optFrame('NSE_FO|N0325000CE', 101.5, 101.4, 101.6, clock.now));
        fake.push(optFrame('NSE_FO|N0325050CE', 80, null, null, clock.now));          // no depth: dropped
        fake.push(optFrame('NSE_FO|SOMETHINGELSE', 5, 4.9, 5.1, clock.now));            // not ours: dropped
        await waitFor(() => ticks.some(t => t.kind === 'option'));
        await new Promise(r => setTimeout(r, 50));
        const opt = ticks.filter(t => t.kind === 'option');
        assert.strictEqual(opt.length, 1);
        assert.deepStrictEqual([opt[0].sym, opt[0].instrumentKey, opt[0].b, opt[0].a, opt[0].ltp], ['NIFTY26N0325000CE', 'NSE_FO|N0325000CE', 101.4, 101.6, 101.5]);
        assert.ok(paperMod.NIFTY_OPT_SYMBOL_REGEX.test(opt[0].sym));
    } finally { await feed.stop(); await fake.close(); }
});

test('Upstox feed: spot moving 100+ points widens the window and never drops a subscribed contract', async () => {
    const fake = await fakeUpstoxFeedServer();
    const clock = createClock(at(10, 0));
    const feed = feedMod.createUpstoxMarketFeed({ url: fake.url, getAccessToken: () => 'T', getContracts: feedContracts, getTime: clock.getTime, watchMs: 1e9 });
    try {
        await feed.start();
        await waitFor(() => fake.subs.length >= 1);
        fake.push(idxFrame(25000, clock.now));
        await waitFor(() => fake.subscribedKeys().size === 43);
        fake.push(idxFrame(25160, clock.now));
        await waitFor(() => fake.subscribedKeys().has('NSE_FO|N0325650CE'), 3000, 'widened window');
        assert.ok(fake.subscribedKeys().has('NSE_FO|N0324500PE'));
        assert.ok(!fake.subs.some(x => x.method !== 'sub'), 'no unsubscribe');
    } finally { await feed.stop(); await fake.close(); }
});

test('Upstox feed: dropped connection reconnects and resubscribes everything; a silent socket in market hours is dropped', async () => {
    const fake = await fakeUpstoxFeedServer();
    const clock = createClock(at(10, 0));
    const feed = feedMod.createUpstoxMarketFeed({ url: fake.url, getAccessToken: () => 'T', getContracts: feedContracts, getTime: clock.getTime, watchMs: 1e9 });
    try {
        await feed.start();
        await waitFor(() => fake.subs.length >= 1);
        fake.push(idxFrame(25000, clock.now));
        await waitFor(() => fake.subscribedKeys().size === 43);
        fake.conns[0].terminate();                               // Upstox drops us
        await waitFor(() => !feed.isConnected());
        clock.now += 2000; feed._watch();                         // after backoff
        await waitFor(() => fake.conns.length === 2 && fake.subs.filter(x => x.data.instrumentKeys.length).length >= 2);
        const second = fake.subs.slice(1).flatMap(x => x.data.instrumentKeys);
        assert.strictEqual(new Set(second).size, 43, 'all 43 resubscribed on the new connection');
        clock.now += 31000; feed._watch();                        // connected but silent for 31 s at 10:00 IST
        await waitFor(() => !feed.isConnected(), 3000, 'stale socket dropped');
        assert.match(feed.getStats().lastError, /no data/);
    } finally { await feed.stop(); await fake.close(); }
});

test('Upstox feed: a corrupt frame is counted and ignored, the feed keeps running', async () => {
    const fake = await fakeUpstoxFeedServer();
    const clock = createClock(at(10, 0));
    const ticks = [];
    const feed = feedMod.createUpstoxMarketFeed({ url: fake.url, getAccessToken: () => 'T', getContracts: feedContracts, getTime: clock.getTime, watchMs: 1e9 });
    feed.onTick(async (t) => ticks.push(t));
    try {
        await feed.start();
        await waitFor(() => fake.subs.length >= 1);
        fake.conns[0].send(Buffer.from([0xff, 0xff, 0xff, 0x01]));
        fake.push(idxFrame(25000, clock.now));
        await waitFor(() => ticks.length === 1);
        assert.strictEqual(feed.getStats().decodeErrors, 1);
        assert.ok(feed.isConnected());
    } finally { await feed.stop(); await fake.close(); }
});

test('Upstox feed end-to-end: feed -> runner -> server: source goes live, option quotes reach the paper position, keys auto-register', async () => {
    const fake = await fakeUpstoxFeedServer();
    const clock = createClock(at(10, 0));
    const feed = feedMod.createUpstoxMarketFeed({ url: fake.url, getAccessToken: () => 'T', getContracts: feedContracts, getTime: clock.getTime, watchMs: 1e9 });
    const runner = { factory: (opts) => runnerMod.createRunner({ ...opts, feeds: [feed] }) };
    const { srv } = makeServer({ clock, env: TIGHT, runner });
    try {
        await srv.boot();
        await waitFor(() => fake.subs.length >= 1);
        assert.strictEqual(srv.runner.getFailoverManager().getSource(), 'UNKNOWN');
        fake.push(idxFrame(25010, clock.now));
        await waitFor(() => srv.runner.getFailoverManager().getSource() === 'UPSTOX');
        await srv.riskGovernor.armMode('PAPER');
        const r = await srv.paperEngine.evaluateSignalForEntry(sig('F1', 100, { contract: { symbol: 'NIFTY26N0325000CE' } }));
        assert.strictEqual(r.status, 'OPENED', r.reason);
        fake.push(optFrame('NSE_FO|N0325000CE', 94, 94.0, 94.2, clock.now));       // stop hit at the real bid
        await waitFor(() => srv.paperEngine.getCompletedTrades().length === 1, 3000, 'paper stop');
        assert.strictEqual(srv.paperEngine.getCompletedTrades()[0].exitReason, 'STOP_LOSS_SL_TRIGGERED');
        assert.strictEqual(srv.runner.resolveInstrumentKey('NIFTY26N0325000CE'), 'NSE_FO|N0325000CE');
    } finally { await feed.stop(); await fake.close(); }
});

// =============================================================== UPSTOX CLIENT (fake fetch)
function fakeFetch(responder) {
    const calls = [];
    const fn = async (url, init = {}) => { calls.push({ url, ...init }); const { status = 200, json } = responder(url, init); return { status, ok: status >= 200 && status < 300, json: async () => json }; };
    fn.calls = calls;
    return fn;
}

test('Upstox client: place order = POST api-hft v3 with Bearer + X-Algo-Name and correct body', async () => {
    const f = fakeFetch(() => ({ json: { status: 'success', data: { order_ids: ['2511030001'] } } }));
    const c = upstoxMod.createUpstoxClient({ fetchFn: f, getAccessToken: () => 'TOK', algoName: 'hell-orb-v1' });
    const r = await c.placeOrder({ instrumentKey: IKEY, side: 'SELL', orderType: 'SL', quantity: 65, limitPrice: 94.2, triggerPrice: 95.2, tag: 'HELLabc' });
    assert.strictEqual(r.brokerOrderId, '2511030001');
    const call = f.calls[0];
    assert.strictEqual(call.url, 'https://api-hft.upstox.com/v3/order/place');
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.headers.Authorization, 'Bearer TOK');
    assert.strictEqual(call.headers['X-Algo-Name'], 'hell-orb-v1');
    const b = JSON.parse(call.body);
    assert.deepStrictEqual([b.instrument_token, b.order_type, b.transaction_type, b.quantity, b.price, b.trigger_price, b.product, b.validity, b.slice], [IKEY, 'SL', 'SELL', 65, 94.2, 95.2, 'I', 'DAY', false]);
});

test('Upstox client: refuses MARKET orders and missing algo name before any HTTP call', async () => {
    const f = fakeFetch(() => ({ json: { status: 'success', data: { order_ids: ['1'] } } }));
    await assert.rejects(() => upstoxMod.createUpstoxClient({ fetchFn: f, getAccessToken: () => 'T', algoName: 'a' }).placeOrder({ instrumentKey: IKEY, side: 'BUY', orderType: 'MARKET', quantity: 65, limitPrice: 0 }));
    await assert.rejects(() => upstoxMod.createUpstoxClient({ fetchFn: f, getAccessToken: () => 'T' }).placeOrder({ instrumentKey: IKEY, side: 'BUY', orderType: 'LIMIT', quantity: 65, limitPrice: 100 }));
    assert.strictEqual(f.calls.length, 0);
});

test('Upstox client: 401 fires the auth hook; error bodies surface the Upstox code', async () => {
    let hook = null;
    const c401 = upstoxMod.createUpstoxClient({ fetchFn: fakeFetch(() => ({ status: 401, json: { status: 'error' } })), getAccessToken: () => 'T', algoName: 'a', onAuthError: (s) => { hook = s; } });
    await assert.rejects(() => c401.getPositions(), /auth rejected/);
    assert.strictEqual(hook, 401);
    const cErr = upstoxMod.createUpstoxClient({ fetchFn: fakeFetch(() => ({ status: 400, json: { status: 'error', errors: [{ errorCode: 'UDAPI100074', message: 'outside hours' }] } })), getAccessToken: () => 'T', algoName: 'a' });
    await assert.rejects(() => cErr.getOrder('1'), /UDAPI100074/);
});

test('Upstox client: order status/fill normalisation, positions and funds parsing', async () => {
    const f = fakeFetch((url) => {
        if (url.includes('/order/details')) return { json: { status: 'success', data: { order_id: '9', status: 'trigger pending', quantity: 65, filled_quantity: 0, pending_quantity: 65, average_price: 0, transaction_type: 'SELL', order_type: 'SL', instrument_token: IKEY, tag: 'HELLx' } } };
        if (url.includes('short-term-positions')) return { json: { status: 'success', data: [{ instrument_token: IKEY, trading_symbol: SYMBOL, quantity: 65, buy_price: 100.25 }] } };
        if (url.includes('funds-and-margin')) return { json: { status: 'success', data: { equity: { available_margin: 9876.5 } } } };
        return { json: { status: 'success', data: {} } };
    });
    const c = upstoxMod.createUpstoxClient({ fetchFn: f, getAccessToken: () => 'T', algoName: 'a' });
    const o = await c.getOrder('9');
    assert.deepStrictEqual([o.status, o.filledQty, o.side, o.orderType], ['TRIGGER_PENDING', 0, 'SELL', 'SL']);
    assert.deepStrictEqual(await c.getPositions(), [{ instrumentKey: IKEY, symbol: SYMBOL, netQty: 65, avgEntryPrice: 100.25, product: undefined }]);
    assert.strictEqual(await c.getAvailableMargin(), 9876.5);
    assert.deepStrictEqual(['complete', 'open', 'rejected', 'cancelled', 'open pending'].map(upstoxMod.normalizeStatus), ['COMPLETE', 'OPEN', 'REJECTED', 'CANCELLED', 'PENDING']);
});

test('Upstox token exchange is form-encoded with authorization_code grant', async () => {
    const f = fakeFetch(() => ({ json: { access_token: 'NEW' } }));
    const t = await upstoxMod.exchangeUpstoxAuthCode({ fetchFn: f, code: 'C', clientId: 'id', clientSecret: 's', redirectUri: 'https://x/cb' });
    assert.strictEqual(t, 'NEW');
    assert.strictEqual(f.calls[0].url, 'https://api.upstox.com/v2/login/authorization/token');
    assert.match(f.calls[0].body, /grant_type=authorization_code/);
    assert.strictEqual(f.calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
});

// ---------------------------------------------------------------- run
(async () => {
    let pass = 0;
    for (const t of tests) {
        try { await t.fn(); pass++; console.log(`PASS  ${t.name}`); }
        catch (err) { console.log(`FAIL  ${t.name}\n      ${err && err.stack ? err.stack.split("\n").slice(0, 8).join('\n      ') : err}`); }
    }
    console.log(`\n${pass}/${tests.length} passed`);
    process.exit(pass === tests.length ? 0 : 1);
})();
