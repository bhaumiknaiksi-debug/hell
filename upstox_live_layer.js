'use strict';

// Live order manager. Talks to the broker only through a normalized client
// (see upstox_client.js). Core rules:
//  - Entry fill is read from order STATUS, never from the place-order reply.
//  - After cancelling an entry, the final filled qty is re-read, so a fill that
//    lands during the cancel still gets a stop.
//  - Every filled qty gets a resting broker SL before the entry is reported OPENED.
//  - The resting SL is never cancelled while the exit is unfilled: exits convert
//    the SL order itself into a chasing LIMIT. Only if the broker refuses that
//    modify do we cancel, confirm the cancel, then place a separate exit.

const paperMod = require('./paper_engine.js');

const POLL_MS = 250;
const ENTRY_FILL_WAIT_MS = 3000;
const CANCEL_CONFIRM_WAIT_MS = 3000;
const SL_CONFIRM_WAIT_MS = 3000;
// Exit chaser (Stage 5 "unfilled chaser rule"):
//  step 1: SELL LIMIT at bid - ₹0.50, given EXIT_ESCALATE_AFTER_MS (default 3 s) to fill;
//  then every ESCALATION_STEP_MS the price drops by a growing amount until, at the
//  last step, it is ₹0.05: a sell that low is marketable against any bid, so it
//  fills at the best bid. MARKET orders stay forbidden.
//  If even the ₹0.05 sell is unfilled after FLOOR_WAIT_MS the order is left resting
//  (never cancelled) and every heartbeat keeps watching it and alerting.
const DEFAULT_CHASE = Object.freeze({ escalateAfterMs: 3000, stepMs: 1000, floorWaitMs: 30000 });
const CHASE_DROPS_RS = [0.50, 2.00, 5.00];   // step 1..3 below the reference bid; step 4 = ₹0.05
const MAX_CHASE_STEPS = CHASE_DROPS_RS.length + 1;
const KILL_IDLE_WAIT_MS = 15000;
const TAG_PREFIX = 'HELL';

function posInt(v, def) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; }
function isTuesdayIst(ms) { return new Date(ms + 19800000).getUTCDay() === 2; }  // NIFTY weekly expiry day

const TERMINAL = new Set(['COMPLETE', 'REJECTED', 'CANCELLED']);
const LIVE_SL = new Set(['TRIGGER_PENDING', 'OPEN', 'PENDING']);

function createLiveOrderManager({
    getTime,
    riskGovernor,
    auditLog,
    getBrokerClient,                         // () => normalized client (throws if not logged in)
    sleepFn = (ms) => new Promise(r => setTimeout(r, ms)),
    onAlert = async () => {},
    onStateChange = () => {},
    resolveInstrumentKey = null,             // (symbol) => key | null (from runner / instrument master)
    chaseConfig = {}
}) {
    const chase = {
        escalateAfterMs: posInt(chaseConfig.escalateAfterMs, DEFAULT_CHASE.escalateAfterMs),
        stepMs: posInt(chaseConfig.stepMs, DEFAULT_CHASE.stepMs),
        floorWaitMs: posInt(chaseConfig.floorWaitMs, DEFAULT_CHASE.floorWaitMs)
    };
    if (typeof getBrokerClient !== 'function') throw new Error('getBrokerClient is required');

    let position = null;          // the one open live position
    let pendingEntryOrderId = null;
    let completedLiveTrades = [];
    let busy = false;
    let killRequested = false;
    let tagSeq = 0;

    const broker = () => getBrokerClient();
    const changed = () => { try { onStateChange(exportState()); } catch (_) {} };
    const newTag = () => `${TAG_PREFIX}${(getTime() % 1e9).toString(36)}${(++tagSeq).toString(36)}`.slice(0, 20);

    function exportState() {
        return JSON.stringify({ v: 1, position, pendingEntryOrderId, completedLiveTrades: completedLiveTrades.slice(-500) });
    }
    function importState(json) {
        const st = typeof json === 'string' ? JSON.parse(json) : json;
        if (!st || st.v !== 1) throw new Error('Unrecognised live state');
        position = st.position || null;
        pendingEntryOrderId = st.pendingEntryOrderId || null;
        completedLiveTrades = Array.isArray(st.completedLiveTrades) ? st.completedLiveTrades : [];
    }

    async function pollOrder(id, done, timeoutMs) {
        const start = getTime();
        let o = await broker().getOrder(id);
        while (!done(o) && getTime() - start < timeoutMs) {
            await sleepFn(POLL_MS);
            o = await broker().getOrder(id);
        }
        return o;
    }

    async function gatedPlace(order) {
        const gate = await riskGovernor.validatePreSendOrder(order, getTime());
        if (!gate.allowed) {
            await auditLog.append('LIVE', 'ORDER_BLOCKED_BY_GOVERNOR', gate.reason, { side: order.side, orderType: order.orderType });
            return { blocked: true, reason: gate.reason };
        }
        const tag = newTag();
        const res = await broker().placeOrder({ ...order, tag });
        await auditLog.append('LIVE', 'ORDER_PLACED', `${order.side} ${order.orderType}`, { brokerOrderId: res.brokerOrderId, tag, qty: order.quantity, limitPrice: order.limitPrice, triggerPrice: order.triggerPrice || null });
        return { blocked: false, brokerOrderId: res.brokerOrderId, tag };
    }

    function stopLevels(avgEntry) {
        const pc = riskGovernor.getPlanConfig();
        return {
            triggerPrice: paperMod.roundTick(Math.max(0.15, avgEntry - pc.stopTriggerOffsetRs)),
            limitPrice: paperMod.roundTick(Math.max(0.10, avgEntry - pc.stopLimitFloorOffsetRs))
        };
    }

    // Books the trade. Fills from earlier exit orders that ended part-filled
    // (pos.priorExitQty / pos.priorExitValue) are combined with this order's fill,
    // so P&L is on the whole entry quantity at the real average exit price.
    async function closeFromOrder(order, reason) {
        const pos = position;
        if (!pos) return null;
        const thisQty = Number(order.filledQty) || pos.qty;
        const thisPrice = order.avgFillPrice || order.limitPrice;
        const totalQty = (pos.priorExitQty || 0) + thisQty;
        const exitPrice = +(((pos.priorExitValue || 0) + thisPrice * thisQty) / totalQty).toFixed(2);
        const pnl = paperMod.calculate2026OptionTradePnl({ entryPrice: pos.avgEntryPrice, exitPrice, quantity: pos.entryQty || totalQty });
        const nowMs = getTime();
        await riskGovernor.recordTradeClosed(nowMs, pnl.netPnl);
        const rec = { ...pos, qty: pos.entryQty || totalQty, exitPrice, exitReason: reason, exitedAtMs: nowMs, netPnl: pnl.netPnl, grossPnl: pnl.grossPnl, totalCharges: pnl.totalCharges };
        completedLiveTrades.push(rec);
        position = null;
        changed();
        await auditLog.append('LIVE', 'POSITION_CLOSED', reason, { exitPrice, netPnl: pnl.netPnl });
        await onAlert(`LIVE EXIT ${pos.symbol} @ ₹${exitPrice} (${reason}) net ₹${pnl.netPnl}`);
        return { closed: true, reason, exitPrice, netPnl: pnl.netPnl };
    }

    // Places the resting stop for the current position. Returns false if the
    // position could not be protected (caller must exit).
    async function placeProtectiveSl() {
        const pos = position;
        const lv = stopLevels(pos.avgEntryPrice);
        let placed;
        try {
            placed = await gatedPlace({ symbol: pos.symbol, instrumentKey: pos.instrumentKey, side: 'SELL', orderType: 'SL', quantity: pos.qty, triggerPrice: lv.triggerPrice, limitPrice: lv.limitPrice });
        } catch (err) {
            placed = { blocked: true, reason: `BROKER_ERROR: ${err.message}` };
        }
        if (placed.blocked) {
            await onAlert(`SL PLACEMENT FAILED for ${pos.symbol}: ${placed.reason}. Exiting.`);
            return false;
        }
        const o = await pollOrder(placed.brokerOrderId, x => x && x.status !== 'PENDING', SL_CONFIRM_WAIT_MS);
        if (o.status === 'REJECTED' || o.status === 'CANCELLED') {
            await onAlert(`SL ${o.status} for ${pos.symbol} (${o.statusMessage || ''}). Exiting.`);
            return false;
        }
        pos.slOrderId = placed.brokerOrderId;
        pos.stopTriggerPrice = lv.triggerPrice;
        pos.stopLimitPrice = lv.limitPrice;
        pos.slTriggeredAtMs = null;
        changed();
        if (o.status === 'COMPLETE') { await closeFromOrder(o, 'BROKER_SL_FILLED'); return true; }
        return true;
    }

    function priceForStep(refBid, step) {
        if (step >= MAX_CHASE_STEPS) return 0.05;
        return paperMod.roundTick(Math.max(0.05, refBid - CHASE_DROPS_RS[step - 1]));
    }

    // Exit fill that ended without completing (cancelled/rejected after a part fill):
    // bank the filled part and shrink the position to what is still held.
    function bankPartial(o) {
        const f = Number(o.filledQty) || 0;
        if (f <= 0 || !position) return;
        position.priorExitQty = (position.priorExitQty || 0) + f;
        position.priorExitValue = (position.priorExitValue || 0) + f * (o.avgFillPrice || o.limitPrice);
        position.qty -= f;
        changed();
    }

    // Exit the open position. Caller must hold `busy`.
    async function runExit(reason, bidHint = null) {
        const pos = position;
        if (!pos) return { closed: true, reason: 'NO_POSITION' };
        const refBid = [bidHint, pos.lastBid].find(v => Number.isFinite(v) && v > 0) || pos.avgEntryPrice;

        let exitOrderId = null;
        let exitQty = pos.qty;

        // Path A: turn the resting SL into a chasing LIMIT (no naked window).
        if (pos.slOrderId) {
            const cur = await broker().getOrder(pos.slOrderId);
            if (cur.status === 'COMPLETE') return closeFromOrder(cur, 'BROKER_SL_FILLED');
            if (LIVE_SL.has(cur.status)) {
                try {
                    await broker().modifyOrder(pos.slOrderId, { orderType: 'LIMIT', quantity: cur.quantity || pos.qty, limitPrice: priceForStep(refBid, 1) });
                    exitOrderId = pos.slOrderId;
                    exitQty = cur.quantity || pos.qty;
                    await auditLog.append('LIVE', 'SL_CONVERTED_TO_EXIT', reason, { brokerOrderId: exitOrderId });
                } catch (err) {
                    await auditLog.append('LIVE', 'SL_MODIFY_REFUSED', String(err.message), {});
                }
            }
            // Path B: modify refused. Cancel, CONFIRM the cancel, then place a fresh exit.
            if (!exitOrderId) {
                if (LIVE_SL.has(cur.status)) { try { await broker().cancelOrder(pos.slOrderId); } catch (_) {} }
                const c = await pollOrder(pos.slOrderId, x => TERMINAL.has(x.status), CANCEL_CONFIRM_WAIT_MS);
                if (c.status === 'COMPLETE') return closeFromOrder(c, 'BROKER_SL_FILLED');
                if (!TERMINAL.has(c.status)) {
                    // Unknown: placing another SELL could double-sell. Halt and shout.
                    await riskGovernor.setReconciliationMismatch('SL_CANCEL_UNCONFIRMED', { slOrderId: pos.slOrderId });
                    await onAlert(`EXIT BLOCKED: could not confirm SL cancel for ${pos.symbol}. Check Upstox manually NOW.`);
                    return { closed: false, reason: 'SL_CANCEL_UNCONFIRMED' };
                }
                bankPartial(c);
                exitQty = pos.qty;
                pos.slOrderId = null; changed();
            }
        }
        return chaseExit(reason, refBid, exitOrderId, exitQty, 1);
    }

    // Drives one exit order (placing it if needed) down the price ladder until flat.
    async function chaseExit(reason, refBid, exitOrderId, exitQty, startStep) {
        const pos = position;
        const placeExit = async (step) => {
            let placed;
            try {
                placed = await gatedPlace({ symbol: pos.symbol, instrumentKey: pos.instrumentKey, side: 'SELL', orderType: 'LIMIT', quantity: pos.qty, limitPrice: priceForStep(refBid, step) });
            } catch (err) { placed = { blocked: true, reason: `BROKER_ERROR: ${err.message}` }; }
            return placed;
        };
        if (!exitOrderId) {
            const placed = await placeExit(startStep);
            if (placed.blocked) {
                await onAlert(`EXIT ORDER FAILED for ${pos.symbol}: ${placed.reason}. Re-protecting.`);
                if (!pos.slOrderId) await placeProtectiveSl();
                return { closed: false, reason: placed.reason };
            }
            exitOrderId = placed.brokerOrderId;
        }
        pos.exitOrderId = exitOrderId; pos.exitReason = reason; changed();

        for (let step = startStep; step <= MAX_CHASE_STEPS; step++) {
            const waitMs = step === MAX_CHASE_STEPS ? chase.floorWaitMs : (step === 1 ? chase.escalateAfterMs : chase.stepMs);
            const o = await pollOrder(exitOrderId, x => TERMINAL.has(x.status), waitMs);
            if (o.status === 'COMPLETE') return closeFromOrder(o, reason);
            if (o.status === 'REJECTED' || o.status === 'CANCELLED') {
                bankPartial(o);
                pos.exitOrderId = null; if (exitOrderId === pos.slOrderId) pos.slOrderId = null; changed();
                if (pos.qty <= 0) { position = null; changed(); return { closed: true, reason }; }
                await onAlert(`EXIT ORDER ${o.status} for ${pos.symbol} (${o.statusMessage || 'no reason'}) after ${o.filledQty || 0} filled; ${pos.qty} still held. Placing a new exit.`);
                const placed = await placeExit(Math.min(step + 1, MAX_CHASE_STEPS));
                if (placed.blocked) {
                    await onAlert(`EXIT ORDER FAILED for ${pos.symbol}: ${placed.reason}. Re-protecting.`);
                    await placeProtectiveSl();
                    return { closed: false, reason: `EXIT_${o.status}` };
                }
                exitOrderId = placed.brokerOrderId; pos.exitOrderId = exitOrderId; changed();
                continue;
            }
            if (step < MAX_CHASE_STEPS) {
                const next = priceForStep(refBid, step + 1);
                const filledTxt = o.filledQty ? `${o.filledQty} filled @ ₹${o.avgFillPrice}, ${(o.quantity || exitQty) - o.filledQty} left` : 'nothing filled';
                await onAlert(`EXIT ESCALATING ${pos.symbol} (${reason}): ${filledTxt}; sell limit moved to ₹${next}.`);
                await auditLog.append('LIVE', 'EXIT_ESCALATED', reason, { step: step + 1, limitPrice: next, filledQty: o.filledQty || 0, avgFillPrice: o.avgFillPrice || null });
                try { await broker().modifyOrder(exitOrderId, { orderType: 'LIMIT', quantity: o.quantity || exitQty, limitPrice: next }); } catch (_) {}
            }
        }
        // Still unfilled at ₹0.05: the sell keeps resting (position still covered by it).
        await onAlert(`EXIT NOT FILLED for ${pos.symbol} even at ₹0.05 after ${Math.round(chase.floorWaitMs / 1000)} s. Order left resting; check Upstox NOW.`);
        return { closed: false, reason: 'EXIT_RESTING' };
    }

    async function executeSignalEntry(signal) {
        if (busy) return { status: 'BLOCKED', reason: 'LIVE_MANAGER_BUSY' };
        busy = true;
        try {
            const nowMs = getTime();
            if (!signal || !signal.signalId) return { status: 'IGNORED', reason: 'INVALID_SIGNAL' };
            const gate = await riskGovernor.canOpenNewTrade({ nowMs, openPositionCount: (position || pendingEntryOrderId) ? 1 : 0 });
            if (!gate.allowed) return { status: 'BLOCKED', reason: gate.reason };
            if (signal.quoteStatus !== 'VERIFIED' || !signal.quote || !Number.isFinite(signal.quote.ask)) return { status: 'BLOCKED', reason: 'UNVERIFIED_OPTION_QUOTE' };
            let instrumentKey = signal.contract && signal.contract.instrumentKey;
            if (!instrumentKey && typeof resolveInstrumentKey === 'function' && signal.contract && signal.contract.symbol) {
                try { instrumentKey = resolveInstrumentKey(signal.contract.symbol) || null; } catch (_) { instrumentKey = null; }
            }
            if (!instrumentKey) {
                await auditLog.append('LIVE', 'ENTRY_BLOCKED', 'MISSING_UPSTOX_INSTRUMENT_KEY', { symbol: signal.contract && signal.contract.symbol });
                await onAlert(`NO ORDER: no Upstox instrument key for ${(signal.contract && signal.contract.symbol) || 'unknown contract'}. HELL never guesses a key.`);
                return { status: 'BLOCKED', reason: 'MISSING_UPSTOX_INSTRUMENT_KEY' };
            }

            let plan;
            try {
                plan = paperMod.createFrozenTradePlan({ planId: `PLAN_${signal.signalId}`, signalId: signal.signalId, levelId: signal.levelId, tier: signal.tier || 'A', symbol: signal.contract.symbol, side: signal.side, entryAsk: signal.quote.ask, createdAtMs: nowMs, planConfig: riskGovernor.getPlanConfig() });
            } catch (_) { return { status: 'BLOCKED', reason: 'PLAN_CREATION_FAILED' }; }

            const placed = await gatedPlace({ symbol: plan.symbol, instrumentKey, side: 'BUY', orderType: 'LIMIT', quantity: plan.quantity, limitPrice: plan.entryLimitPrice, candidatePremium: signal.quote.ask });
            if (placed.blocked) return { status: 'BLOCKED', reason: placed.reason };
            pendingEntryOrderId = placed.brokerOrderId; changed();

            let o = await pollOrder(placed.brokerOrderId, x => TERMINAL.has(x.status), ENTRY_FILL_WAIT_MS);
            if (!TERMINAL.has(o.status)) {
                try { await broker().cancelOrder(placed.brokerOrderId); } catch (_) {}
                o = await pollOrder(placed.brokerOrderId, x => TERMINAL.has(x.status), CANCEL_CONFIRM_WAIT_MS);
            }
            pendingEntryOrderId = null;
            const filled = o.filledQty || 0;
            if (!TERMINAL.has(o.status)) {
                await riskGovernor.setReconciliationMismatch('ENTRY_ORDER_STATE_UNKNOWN', { brokerOrderId: placed.brokerOrderId, filled });
                await onAlert(`ENTRY ORDER STATE UNKNOWN (${placed.brokerOrderId}). Live halted. Check Upstox.`);
            }
            if (filled === 0) { changed(); return { status: 'UNFILLED', reason: o.status }; }

            await riskGovernor.recordTradeEntry(nowMs);
            position = {
                signalId: signal.signalId, tier: plan.tier, symbol: plan.symbol, instrumentKey, qty: filled, entryQty: filled,
                expiryDayTuesday: isTuesdayIst(nowMs),
                avgEntryPrice: o.avgFillPrice || plan.entryLimitPrice, plan, entryOrderId: placed.brokerOrderId,
                openedAtMs: nowMs, maxHoldUntilMs: plan.maxHoldUntilMs, targetPrice: plan.targetLimitPrice,
                slOrderId: null, exitOrderId: null, slTriggeredAtMs: null, lastBid: Number.isFinite(signal.quote.bid) ? signal.quote.bid : null
            };
            changed();
            await auditLog.append('LIVE', 'ENTRY_FILLED', `filled ${filled}/${plan.quantity}`, { avg: position.avgEntryPrice });

            if (killRequested) { await runExit('KILL_DURING_ENTRY'); return { status: 'FLATTENED_ON_KILL' }; }
            const ok = await placeProtectiveSl();
            if (!ok) { await runExit('PROTECTIVE_SL_FAILED'); return { status: 'FLATTENED_ON_SL_FAILURE' }; }
            if (!position) return { status: 'CLOSED_IMMEDIATELY' };
            await onAlert(`LIVE ENTRY ${position.symbol} ${filled} @ ₹${position.avgEntryPrice}, SL ${position.stopTriggerPrice}/${position.stopLimitPrice}`);
            return { status: 'OPENED', position: Object.freeze({ ...position }) };
        } finally { busy = false; }
    }

    function onQuote(quote) {
        if (position && quote && quote.symbol === position.symbol && Number.isFinite(quote.bid) && quote.bid > 0) position.lastBid = quote.bid;
    }

    async function stepLivePosition(nowMs = getTime()) {
        if (!position || busy) return null;
        busy = true;
        try {
            const pos = position;
            if (pos.exitOrderId) {
                const o = await broker().getOrder(pos.exitOrderId);
                if (o.status === 'COMPLETE') return closeFromOrder(o, pos.exitReason || 'EXIT_FILLED');
                if (o.status === 'REJECTED' || o.status === 'CANCELLED') {
                    bankPartial(o);
                    pos.exitOrderId = null; if (pos.slOrderId === o.brokerOrderId) pos.slOrderId = null; changed();
                    if (pos.qty <= 0) { position = null; changed(); return { closed: true }; }
                    // An exit was in progress: finish it rather than going back to a stop.
                    return chaseExit(pos.exitReason || 'RESUMED_EXIT', pos.lastBid || pos.avgEntryPrice, null, pos.qty, MAX_CHASE_STEPS);
                }
                if (o.limitPrice > 0.05) {
                    try { await broker().modifyOrder(pos.exitOrderId, { orderType: 'LIMIT', quantity: o.quantity || pos.qty, limitPrice: 0.05 }); } catch (_) {}
                }
                return null;
            }
            if (!pos.slOrderId) {
                await onAlert(`No resting SL recorded for ${pos.symbol}. Placing one.`);
                if (!(await placeProtectiveSl())) return runExit('SL_MISSING_AND_PLACE_FAILED');
                return null;
            }
            const sl = await broker().getOrder(pos.slOrderId);
            if (sl.status === 'COMPLETE') return closeFromOrder(sl, 'BROKER_SL_FILLED');
            if (sl.status === 'REJECTED' || sl.status === 'CANCELLED') {
                await onAlert(`Resting SL for ${pos.symbol} is ${sl.status}. Re-placing.`);
                pos.slOrderId = null;
                if (!(await placeProtectiveSl())) return runExit('SL_LOST_AND_REPLACE_FAILED');
                return null;
            }
            if (sl.status === 'OPEN') { // triggered but not filled
                if (!pos.slTriggeredAtMs) { pos.slTriggeredAtMs = nowMs; changed(); }
                if (nowMs - pos.slTriggeredAtMs >= paperMod.SL_TRIGGER_UNFILLED_CHASE_MS) return runExit('SL_TRIGGERED_UNFILLED_CHASE');
                return null;
            }
            const tech = riskGovernor.checkTechnicalHealth(nowMs);
            if (!tech.ok) return runExit(`HEALTH_HALT:${tech.reason}`);
            if (Number.isFinite(pos.lastBid) && pos.lastBid >= pos.targetPrice) return runExit('TARGET_HIT');
            if (nowMs >= pos.maxHoldUntilMs) return runExit('TIME_STOP_30M');
            if (paperMod.getIstDateKeyAndMinutes(nowMs).minutesIst >= paperMod.EOD_FLATTEN_MINUTES_IST) return runExit('EOD_1515');
            if (Number.isFinite(pos.lastBid)) {
                const mark = paperMod.calculate2026OptionTradePnl({ entryPrice: pos.avgEntryPrice, exitPrice: pos.lastBid, quantity: pos.qty });
                const breach = await riskGovernor.updateUnrealizedPnl(nowMs, mark.netPnl);
                if (breach.breached) return runExit('DAILY_LOSS_CAP');
            }
            return null;
        } catch (err) {
            await auditLog.append('LIVE', 'STEP_ERROR', String(err.message), {});
            return { error: err.message };
        } finally { busy = false; }
    }

    // Works even while an entry is in flight: flags the entry, waits for the
    // bounded poll to finish, then exits whatever is held.
    async function killAll(reason = 'KILL', bidHint = null) {
        killRequested = true;
        try {
            const start = getTime();
            while (busy && getTime() - start < KILL_IDLE_WAIT_MS) await sleepFn(POLL_MS);
            if (busy) {
                await onAlert('KILL: live manager still busy after 15s. Check Upstox manually.');
                return { ok: false, reason: 'BUSY_TIMEOUT' };
            }
            busy = true;
            try {
                if (pendingEntryOrderId) {
                    try { await broker().cancelOrder(pendingEntryOrderId); } catch (_) {}
                    pendingEntryOrderId = null; changed();
                }
                if (!position) return { ok: true, flat: true };
                if (position.exitOrderId) {
                    // Exit already resting: push it to the floor.
                    const r = await chaseExit(reason, bidHint || position.lastBid || position.avgEntryPrice, position.exitOrderId, position.qty, MAX_CHASE_STEPS);
                    if (!r.closed) return { ok: false, ...r };
                    return { ok: true, flat: true, closed: true, ...r };
                }
                const r = await runExit(reason, bidHint);
                return { ok: Boolean(r && r.closed), ...r };
            } finally { busy = false; }
        } finally { killRequested = false; }
    }

    async function reconcileWithBroker() {
        const positions = (await broker().getPositions()).filter(p => Number(p.netQty) !== 0);
        const orders = await broker().getOrders();
        const ours = new Set([position && position.slOrderId, position && position.exitOrderId, pendingEntryOrderId].filter(Boolean));
        const stray = orders.filter(o => o.tag && String(o.tag).startsWith(TAG_PREFIX) && !TERMINAL.has(o.status) && !ours.has(o.brokerOrderId));

        if (positions.length === 0 && position) {
            const ids = [position.slOrderId, position.exitOrderId].filter(Boolean);
            const done = orders.find(o => ids.includes(o.brokerOrderId) && o.status === 'COMPLETE');
            if (done) { await closeFromOrder(done, 'CLOSED_WHILE_AWAY'); return { matched: stray.length === 0, closedWhileAway: true, stray }; }
        }
        const p = positions[0];
        const matched = stray.length === 0 && (
            (positions.length === 0 && !position) ||
            (positions.length === 1 && position && p.instrumentKey === position.instrumentKey && p.netQty === position.qty)
        );
        if (!matched) {
            const detail = { local: position ? { instrumentKey: position.instrumentKey, qty: position.qty } : null, broker: positions, strayOrders: stray.map(o => o.brokerOrderId) };
            await riskGovernor.setReconciliationMismatch('BROKER_POSITION_MISMATCH', detail);
            await onAlert(`RECONCILIATION MISMATCH — live halted. ${JSON.stringify(detail)}`);
            return { matched: false, detail };
        }
        return { matched: true };
    }

    // Called once the Upstox session is available after a (re)start. Never opens trades.
    async function recoverOnBoot() {
        busy = true;
        try {
            const positions = (await broker().getPositions()).filter(p => Number(p.netQty) !== 0);
            const orders = await broker().getOrders();
            // Cancel any stray HELL entry orders left from before the restart.
            for (const o of orders.filter(x => x.tag && String(x.tag).startsWith(TAG_PREFIX) && x.side === 'BUY' && !TERMINAL.has(x.status))) {
                try { await broker().cancelOrder(o.brokerOrderId); } catch (_) {}
            }
            pendingEntryOrderId = null;

            if (positions.length === 0) {
                if (position) {
                    const ids = [position.slOrderId, position.exitOrderId].filter(Boolean);
                    const done = orders.find(o => ids.includes(o.brokerOrderId) && o.status === 'COMPLETE');
                    if (done) await closeFromOrder(done, 'CLOSED_WHILE_DOWN');
                    else {
                        await riskGovernor.setReconciliationMismatch('LOCAL_POSITION_NOT_AT_BROKER', { local: position });
                        await onAlert('BOOT: saved live position not found at broker and no exit fill found. Halted; check Upstox.');
                        return { status: 'MISMATCH' };
                    }
                }
                changed();
                return { status: 'BOOT_CLEAN_FLAT' };
            }
            if (positions.length > 1 || positions[0].netQty < 0) {
                await riskGovernor.setReconciliationMismatch('UNEXPECTED_BROKER_POSITIONS_ON_BOOT', { positions });
                await onAlert(`BOOT: unexpected broker positions ${JSON.stringify(positions)}. Halted.`);
                return { status: 'MISMATCH' };
            }
            const bp = positions[0];
            const resting = orders.find(o => o.instrumentKey === bp.instrumentKey && o.side === 'SELL' && !TERMINAL.has(o.status) && (o.quantity - o.filledQty) === bp.netQty);
            if (!position || position.instrumentKey !== bp.instrumentKey) {
                const avg = Number(bp.avgEntryPrice) || null;
                if (!avg) {
                    await riskGovernor.setReconciliationMismatch('BOOT_POSITION_NO_AVG_PRICE', { bp });
                    await onAlert('BOOT: open position without average price. Halted; manage it in Upstox.');
                    return { status: 'MISMATCH' };
                }
                const nowMs = getTime();
                position = {
                    signalId: `RECOVERED_${nowMs}`, tier: null, symbol: bp.symbol, instrumentKey: bp.instrumentKey, qty: bp.netQty, entryQty: bp.netQty,
                    avgEntryPrice: avg, plan: null, entryOrderId: null, openedAtMs: nowMs, maxHoldUntilMs: nowMs + paperMod.MAX_HOLD_MS,
                    targetPrice: paperMod.roundTick(avg + riskGovernor.getPlanConfig().targetOffsetRs),
                    slOrderId: null, exitOrderId: null, slTriggeredAtMs: null, lastBid: null
                };
            }
            position.qty = bp.netQty;
            if (resting) {
                if (resting.orderType === 'SL') { position.slOrderId = resting.brokerOrderId; position.exitOrderId = null; }
                else { position.exitOrderId = resting.brokerOrderId; position.exitReason = position.exitReason || 'RESUMED_EXIT'; }
                changed();
            } else {
                position.slOrderId = null; position.exitOrderId = null;
                if (!(await placeProtectiveSl())) { await runExit('BOOT_SL_PLACE_FAILED'); return { status: 'FLATTENED' }; }
            }
            await onAlert(`BOOT: managing open live position ${position.symbol} x${position.qty}.`);
            return { status: 'RESUMED_OPEN_POSITION' };
        } finally { busy = false; }
    }

    return {
        exportState, importState, executeSignalEntry, onQuote, stepLivePosition, killAll, reconcileWithBroker, recoverOnBoot,
        getActivePosition: () => position ? Object.freeze({ ...position }) : null,
        hasPendingEntry: () => Boolean(pendingEntryOrderId),
        getCompletedLiveTrades: () => [...completedLiveTrades]
    };
}

module.exports = { createLiveOrderManager, TAG_PREFIX, MAX_CHASE_STEPS, DEFAULT_CHASE, CHASE_DROPS_RS };
