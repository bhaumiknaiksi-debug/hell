'use strict';

const engine = require('./engine.js');

// ---------------------------------------------------------------------------
// Fixed contract facts
// ---------------------------------------------------------------------------
const LOT_SIZE = 65;               // NIFTY lot size from Jan 2026 series
const LOTS = 1;
const ENTRY_TICK_BUFFER_RS = 0.40;
const MAX_ENTRY_LIMIT_PRICE_RS = 135.00;
const SL_TRIGGER_UNFILLED_CHASE_MS = 2000;
const MAX_HOLD_MS = 30 * 60000;
const EXIT_LIMIT_BUFFER_RS = 0.50;

const SESSION_OPEN_MIN_IST = 9 * 60 + 15;
const SESSION_FIRST_BEAT_DEADLINE_MIN_IST = 9 * 60 + 20;
const SESSION_LAST_BEAT_MIN_IST = 15 * 60 + 25;
const SESSION_CLOSE_MIN_IST = 15 * 60 + 30;
const ENTRY_CUTOFF_MINUTES_IST = 14 * 60 + 45;
const EOD_FLATTEN_MINUTES_IST = 15 * 60 + 15;
const MAX_HEARTBEAT_GAP_MS = 120000;

const MAX_CONSECUTIVE_LOSING_DAYS = 3;
const GRADUATION_MIN_SESSIONS = 5;
const GRADUATION_MIN_TRADES = 10;
const NIFTY_OPT_SYMBOL_REGEX = /^NIFTY\d{2}([1-9OND]\d{2}|[A-Z]{3})\d{5}(CE|PE)$/;

// ---------------------------------------------------------------------------
// Stop / target distances — CONFIG, not constants. Defaults are the original
// plan values; the stop-vs-cap trade-off is Bhaumik's decision (set via env).
// ---------------------------------------------------------------------------
const DEFAULT_PLAN_CONFIG = Object.freeze({
    stopTriggerOffsetRs: 8.00,
    stopLimitFloorOffsetRs: 10.00,
    stopChaserMaxSlippageRs: 14.00,
    targetOffsetRs: 16.00
});

function posNum(v, def) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
}

function resolvePlanConfig(cfg = {}) {
    const pc = {
        stopTriggerOffsetRs: posNum(cfg.stopTriggerOffsetRs, DEFAULT_PLAN_CONFIG.stopTriggerOffsetRs),
        stopLimitFloorOffsetRs: posNum(cfg.stopLimitFloorOffsetRs, DEFAULT_PLAN_CONFIG.stopLimitFloorOffsetRs),
        stopChaserMaxSlippageRs: posNum(cfg.stopChaserMaxSlippageRs, DEFAULT_PLAN_CONFIG.stopChaserMaxSlippageRs),
        targetOffsetRs: posNum(cfg.targetOffsetRs, DEFAULT_PLAN_CONFIG.targetOffsetRs)
    };
    if (!(pc.stopTriggerOffsetRs < pc.stopLimitFloorOffsetRs && pc.stopLimitFloorOffsetRs <= pc.stopChaserMaxSlippageRs)) {
        throw new Error('Plan config invalid: need trigger < limit floor <= chaser max slippage');
    }
    return Object.freeze(pc);
}

// Version id embeds the stop config: changing stops starts a fresh graduation.
function planVersionId(pc) {
    return `plan-v2026.5|t${pc.stopTriggerOffsetRs}|f${pc.stopLimitFloorOffsetRs}|c${pc.stopChaserMaxSlippageRs}|g${pc.targetOffsetRs}`;
}

function roundTick(price) {
    return +(Math.round(price * 20) / 20).toFixed(2);
}

function getIstDateKeyAndMinutes(epochMs) {
    const d = new Date(epochMs + 19800000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return { dateKey: `${yyyy}-${mm}-${dd}`, minutesIst: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function calculate2026OptionTradePnl({ entryPrice, exitPrice, quantity = LOT_SIZE }) {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error('Invalid entryPrice');
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) throw new Error('Invalid exitPrice');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Invalid quantity');

    const buyTurnover = entryPrice * quantity;
    const sellTurnover = exitPrice * quantity;
    const totalTurnover = buyTurnover + sellTurnover;

    const brokerage = 40.00;
    const stt = +(sellTurnover * 0.0015).toFixed(2);
    const exchangeTxnCharge = +(totalTurnover * 0.0003503).toFixed(2);
    const sebiTurnoverCharge = +(totalTurnover * 0.000001).toFixed(2);
    const stampDuty = +(buyTurnover * 0.00003).toFixed(2);
    const gst = +((brokerage + exchangeTxnCharge + sebiTurnoverCharge) * 0.18).toFixed(2);

    const totalCharges = +(brokerage + stt + exchangeTxnCharge + sebiTurnoverCharge + stampDuty + gst).toFixed(2);
    const grossPnl = +((exitPrice - entryPrice) * quantity).toFixed(2);
    const netPnl = +(grossPnl - totalCharges).toFixed(2);

    return Object.freeze({ quantity, entryPrice: +entryPrice.toFixed(2), exitPrice: +exitPrice.toFixed(2), grossPnl, totalCharges, netPnl });
}

function createFrozenTradePlan({ planId, signalId, levelId, tier, symbol, side, entryAsk, createdAtMs, planConfig }) {
    if (!planId || !signalId || !levelId) throw new Error('Missing plan identifiers');
    if (!['A', 'B', 'C'].includes(tier)) throw new Error('Invalid tier');
    if (!NIFTY_OPT_SYMBOL_REGEX.test(String(symbol || ''))) throw new Error('Invalid option symbol');
    if (!Number.isFinite(entryAsk) || entryAsk <= 0) throw new Error('Invalid entryAsk');
    if (!Number.isFinite(createdAtMs)) throw new Error('Invalid createdAtMs');
    const pc = planConfig || resolvePlanConfig();

    const entryLimitPrice = roundTick(entryAsk + ENTRY_TICK_BUFFER_RS);
    const stopTriggerPrice = roundTick(Math.max(0.15, entryAsk - pc.stopTriggerOffsetRs));
    const stopLimitFloorPrice = roundTick(Math.max(0.10, entryAsk - pc.stopLimitFloorOffsetRs));
    const stopChaserFloorPrice = roundTick(Math.max(0.05, entryAsk - pc.stopChaserMaxSlippageRs));
    const targetLimitPrice = roundTick(entryAsk + pc.targetOffsetRs);

    const expectedEntryFill = roundTick(entryAsk + 0.05);
    const worstCaseCalc = calculate2026OptionTradePnl({ entryPrice: expectedEntryFill, exitPrice: stopChaserFloorPrice, quantity: LOT_SIZE });

    return Object.freeze({
        versionId: planVersionId(pc),
        planId, signalId, levelId, tier, symbol, side,
        quantity: LOT_SIZE, lots: LOTS,
        entryAsk: +entryAsk.toFixed(2),
        entryLimitPrice, stopTriggerPrice, stopLimitFloorPrice, stopChaserFloorPrice, targetLimitPrice,
        maxHoldUntilMs: createdAtMs + MAX_HOLD_MS,
        idealSlFloorNetLossRs: Math.abs(Math.min(0, calculate2026OptionTradePnl({ entryPrice: expectedEntryFill, exitPrice: stopLimitFloorPrice, quantity: LOT_SIZE }).netPnl)),
        worstCaseNetLossRs: Math.abs(Math.min(0, worstCaseCalc.netPnl)),
        createdAtMs
    });
}

function createDecisionAuditLog(getTime, storageAdapter, secretRedactor = (s) => s) {
    const entries = [];
    let seq = 0;
    // Redact string VALUES only. Running the redactor over serialized JSON corrupts
    // numbers whenever a short secret (e.g. a numeric chat id) appears inside a price.
    function redactDeep(v) {
        if (typeof v === 'string') return secretRedactor(v);
        if (Array.isArray(v)) return v.map(redactDeep);
        if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = redactDeep(x); return o; }
        return v;
    }
    async function append(category, action, reason, metadata = {}) {
        const rec = Object.freeze({
            id: ++seq, ts: getTime(), category: String(category), action: String(action),
            reason: secretRedactor(String(reason || '')), metadata: Object.freeze(redactDeep(JSON.parse(JSON.stringify(metadata || {}))))
        });
        entries.push(rec);
        if (entries.length > 5000) entries.shift();
        if (storageAdapter && typeof storageAdapter.appendDecisionAudit === 'function') {
            try { await storageAdapter.appendDecisionAudit(rec); } catch (_) {}
        }
        return rec;
    }
    return { append, getEntries: () => [...entries], _clearForTest: () => { entries.length = 0; seq = 0; } };
}

// ---------------------------------------------------------------------------
// Risk governor
// ---------------------------------------------------------------------------
function createRiskGovernor({
    getTime,
    gapLedger,
    failoverMgr,
    isPersistenceFailed = () => false,
    getClockSkewMs = () => 0,
    auditLog,
    config = {},
    getAvailableCapitalFn = null,   // async () => rupees; LIVE uses broker funds
    onStateChange = () => {}         // called with exportState() after every mutation
}) {
    const maxDailyLossRs = posNum(config.maxDailyLossRs, 600.00);
    const perTradeRiskRs = posNum(config.perTradeRiskRs, 450.00);
    const maxTradesPerDay = posNum(config.maxTradesPerDay, 2);
    const maxWeeklyLossRs = posNum(config.maxWeeklyLossRs, 1200.00);
    const configCapitalRs = posNum(config.totalCapitalAvailableRs, 10000.00);
    const planConfig = resolvePlanConfig(config);

    let mode = 'SHADOW';
    let armedDateKey = null;
    let telegramConfirmedDateKey = null;
    let emergencyHalted = false;
    let emergencyHaltReason = null;
    let reconciliationMismatch = false;
    let reconciliationReason = null;
    let dailyStats = Object.create(null);
    let completedDays = [];        // full history, never wiped
    let haltBaselineIndex = 0;     // multi-day evaluation starts here after an operator clear
    let multiDayHaltReason = null;

    function exportState() {
        return JSON.stringify({
            v: 1, telegramConfirmedDateKey, emergencyHalted, emergencyHaltReason,
            reconciliationMismatch, reconciliationReason, dailyStats, completedDays, haltBaselineIndex, multiDayHaltReason
        });
    }

    // Restores risk memory. Mode is NEVER restored: every boot starts in SHADOW.
    function importState(json) {
        const st = typeof json === 'string' ? JSON.parse(json) : json;
        if (!st || st.v !== 1) throw new Error('Unrecognised risk state');
        mode = 'SHADOW'; armedDateKey = null;
        telegramConfirmedDateKey = st.telegramConfirmedDateKey || null;
        emergencyHalted = Boolean(st.emergencyHalted);
        emergencyHaltReason = st.emergencyHaltReason || null;
        reconciliationMismatch = Boolean(st.reconciliationMismatch);
        reconciliationReason = st.reconciliationReason || null;
        dailyStats = Object.assign(Object.create(null), st.dailyStats || {});
        completedDays = Array.isArray(st.completedDays) ? st.completedDays : [];
        haltBaselineIndex = Number.isInteger(st.haltBaselineIndex) ? st.haltBaselineIndex : 0;
        multiDayHaltReason = st.multiDayHaltReason || null;
    }

    function changed() { try { onStateChange(exportState()); } catch (_) {} }

    function getDayRecord(dateKey) {
        if (!dailyStats[dateKey]) {
            dailyStats[dateKey] = { dateKey, tradeCount: 0, realizedNetPnl: 0, unrealizedNetPnl: 0, haltedReason: null, finalized: false };
        }
        return dailyStats[dateKey];
    }

    function evaluateMultiDayState() {
        if (multiDayHaltReason) return multiDayHaltReason;
        const window = completedDays.slice(haltBaselineIndex);
        const rollingNet = +(window.slice(-5).reduce((a, d) => a + d.realizedNetPnl, 0)).toFixed(2);
        if (rollingNet <= -maxWeeklyLossRs) {
            multiDayHaltReason = `HALTED_MULTI_DAY_LOSS: Rolling 5-session net ₹${rollingNet.toFixed(2)} (cap -₹${maxWeeklyLossRs.toFixed(2)})`;
        } else if (window.length >= MAX_CONSECUTIVE_LOSING_DAYS && window.slice(-MAX_CONSECUTIVE_LOSING_DAYS).every(d => d.realizedNetPnl < 0)) {
            multiDayHaltReason = `HALTED_CONSECUTIVE_LOSS_DAYS: ${MAX_CONSECUTIVE_LOSING_DAYS} consecutive net-losing sessions`;
        }
        return multiDayHaltReason;
    }

    function getRemainingWeeklyBudgetRs(currentDayNet = 0) {
        const priorNet = completedDays.slice(haltBaselineIndex).slice(-4).reduce((a, d) => a + d.realizedNetPnl, 0);
        return +(maxWeeklyLossRs + priorNet + currentDayNet).toFixed(2);
    }

    function checkTechnicalHealth() {
        if (emergencyHalted) return { ok: false, reason: emergencyHaltReason || 'EMERGENCY_HALT' };
        if (reconciliationMismatch) return { ok: false, reason: 'RECONCILIATION_MISMATCH' };
        if (isPersistenceFailed()) return { ok: false, reason: 'STORAGE_PERSISTENCE_FAILED' };
        if (Math.abs(getClockSkewMs()) > engine.MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'CLOCK_SKEW_EXCEEDED' };
        if (gapLedger && Object.keys(gapLedger.getOpenGaps()).length > 0) return { ok: false, reason: 'OPEN_DATA_GAP' };
        if (failoverMgr && failoverMgr.getSource() === 'UNKNOWN') return { ok: false, reason: 'FEED_SOURCE_UNKNOWN' };
        return { ok: true };
    }

    function getEffectiveMode(nowMs = getTime()) {
        const { dateKey, minutesIst } = getIstDateKeyAndMinutes(nowMs);
        if (mode !== 'SHADOW' && (armedDateKey !== dateKey || minutesIst >= SESSION_CLOSE_MIN_IST)) {
            mode = 'SHADOW';
            armedDateKey = null;
        }
        return mode;
    }

    async function confirmLiveArmOnTelegram(nowMs = getTime()) {
        telegramConfirmedDateKey = getIstDateKeyAndMinutes(nowMs).dateKey;
        await auditLog.append('LIFECYCLE', 'TELEGRAM_LIVE_CONFIRMED', 'Bhaumik confirmed live arming on Telegram', { dateKey: telegramConfirmedDateKey });
        changed();
        return { telegramConfirmedDateKey };
    }

    async function armMode(targetMode, source = 'ADMIN', canArmLiveResult = { allowed: false, reason: 'not evaluated' }) {
        const nowMs = getTime();
        const { dateKey, minutesIst } = getIstDateKeyAndMinutes(nowMs);
        if (!['SHADOW', 'PAPER', 'LIVE'].includes(targetMode)) throw new Error('Invalid mode');
        if (targetMode !== 'SHADOW') {
            const md = evaluateMultiDayState();
            if (md) throw new Error(md);
            if (emergencyHalted) throw new Error(`System is emergency halted: ${emergencyHaltReason}`);
            if (reconciliationMismatch) throw new Error('Cannot arm while broker reconciliation mismatch is unresolved');
            if (minutesIst >= SESSION_CLOSE_MIN_IST) throw new Error('Session closed for today');
        }
        if (targetMode === 'LIVE') {
            if (!canArmLiveResult || !canArmLiveResult.allowed) throw new Error(`Paper graduation gate not met: ${canArmLiveResult && canArmLiveResult.reason}`);
            if (telegramConfirmedDateKey !== dateKey) throw new Error('TELEGRAM_CONFIRMATION_MISSING_TODAY: send /confirm-live first');
        }
        mode = targetMode;
        armedDateKey = targetMode === 'SHADOW' ? null : dateKey;
        await auditLog.append('LIFECYCLE', `ARM_${targetMode}`, `Mode set to ${targetMode}`, { source, dateKey });
        changed();
        return { mode, armedDateKey };
    }

    async function disarmToShadow(reason = 'MANUAL_DISARM', source = 'ADMIN') {
        mode = 'SHADOW'; armedDateKey = null;
        await auditLog.append('LIFECYCLE', 'DISARM', reason, { source });
        changed();
        return { mode };
    }

    async function triggerEmergencyKill(reason = 'EMERGENCY_KILL', source = 'OPERATOR') {
        mode = 'SHADOW'; armedDateKey = null;
        emergencyHalted = true;
        emergencyHaltReason = `${source}: ${reason}`;
        await auditLog.append('LIFECYCLE', `EMERGENCY_KILL_${source}`, reason, { source });
        changed();
        return { mode, emergencyHalted, emergencyHaltReason };
    }

    // Clears ONLY the kill latch. Loss history and multi-day halts untouched.
    async function clearEmergencyKill(source = 'ADMIN') {
        emergencyHalted = false; emergencyHaltReason = null;
        await auditLog.append('LIFECYCLE', 'EMERGENCY_KILL_CLEARED', 'Operator cleared kill latch', { source });
        changed();
        return { ok: true };
    }

    async function setReconciliationMismatch(reason, details = {}) {
        reconciliationMismatch = true; reconciliationReason = reason;
        mode = 'SHADOW'; armedDateKey = null;
        await auditLog.append('RECONCILIATION', 'MISMATCH_HALT', reason, details);
        changed();
    }

    // Only the server calls this, and only right after a reconcile that matched.
    async function clearReconciliationMismatch(source = 'RECONCILER') {
        if (!reconciliationMismatch) return { ok: true };
        reconciliationMismatch = false; reconciliationReason = null;
        await auditLog.append('RECONCILIATION', 'MISMATCH_CLEARED', 'Broker and local state agree', { source });
        changed();
        return { ok: true };
    }

    async function recordCompletedDaySummary(dateKey, realizedNetPnl) {
        const idx = completedDays.findIndex(d => d.dateKey === dateKey);
        if (idx >= 0) completedDays[idx].realizedNetPnl = +realizedNetPnl.toFixed(2);
        else completedDays.push({ dateKey, realizedNetPnl: +realizedNetPnl.toFixed(2) });
        completedDays.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
        const halt = evaluateMultiDayState();
        if (halt) {
            mode = 'SHADOW'; armedDateKey = null;
            await auditLog.append('RISK_GOVERNOR', 'MULTI_DAY_HALT_TRIGGERED', halt, { dateKey, realizedNetPnl });
        }
        changed();
        return halt;
    }

    // Closes out any traded day that has ended and was not yet summarised
    // (today after 15:30, or earlier days missed because the server was down).
    async function finalizeDueSessions(nowMs = getTime()) {
        const { dateKey: today, minutesIst } = getIstDateKeyAndMinutes(nowMs);
        const due = Object.values(dailyStats)
            .filter(d => !d.finalized && d.tradeCount > 0 && (d.dateKey < today || (d.dateKey === today && minutesIst >= SESSION_CLOSE_MIN_IST)))
            .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
        for (const d of due) {
            d.finalized = true;
            await recordCompletedDaySummary(d.dateKey, d.realizedNetPnl);
        }
        return due.map(d => d.dateKey);
    }

    // Lifts a multi-day halt without deleting history: evaluation restarts from now.
    async function clearMultiDayHalt(challengePhrase, source = 'ADMIN') {
        if (challengePhrase !== 'CLEAR-HELL-MULTIDAY-HALT') throw new Error('Invalid multi-day reset challenge phrase');
        multiDayHaltReason = null;
        haltBaselineIndex = completedDays.length;
        await auditLog.append('LIFECYCLE', 'MULTI_DAY_HALT_CLEARED', 'Manual operator reset (history kept)', { source, historyDays: completedDays.length });
        changed();
        return { ok: true, historyDaysKept: completedDays.length };
    }

    async function canOpenNewTrade({ nowMs, openPositionCount }) {
        const effMode = getEffectiveMode(nowMs);
        if (effMode === 'SHADOW') return { allowed: false, reason: 'SHADOW_MODE_ONLY' };
        const md = evaluateMultiDayState();
        if (md) return { allowed: false, reason: md };
        const tech = checkTechnicalHealth(nowMs);
        if (!tech.ok) return { allowed: false, reason: tech.reason };

        const { dateKey, minutesIst } = getIstDateKeyAndMinutes(nowMs);
        const day = getDayRecord(dateKey);
        if (day.haltedReason) return { allowed: false, reason: day.haltedReason };
        if (openPositionCount > 0) return { allowed: false, reason: 'MAX_CONCURRENT_POSITION_OPEN' };
        if (minutesIst < SESSION_OPEN_MIN_IST) return { allowed: false, reason: 'BEFORE_SESSION_OPEN' };
        if (minutesIst >= ENTRY_CUTOFF_MINUTES_IST) return { allowed: false, reason: 'AFTER_CUTOFF_1445' };
        if (day.tradeCount >= maxTradesPerDay) return { allowed: false, reason: 'MAX_DAILY_TRADES_REACHED' };

        const remainingDailyBudget = +(maxDailyLossRs + day.realizedNetPnl + day.unrealizedNetPnl).toFixed(2);
        if (remainingDailyBudget <= 0) {
            day.haltedReason = 'HALTED_DAILY_LOSS'; changed();
            return { allowed: false, reason: 'HALTED_DAILY_LOSS' };
        }
        if (remainingDailyBudget < perTradeRiskRs) return { allowed: false, reason: 'INSUFFICIENT_DAILY_RISK_BUDGET' };
        return { allowed: true, mode: effMode, remainingDailyBudget };
    }

    async function validatePreSendOrder(orderRequest, nowMs = getTime()) {
        if (!orderRequest || typeof orderRequest !== 'object') return { allowed: false, reason: 'INVALID_ORDER_PAYLOAD' };
        const isExitOrder = orderRequest.side === 'SELL';
        if (orderRequest.side !== 'SELL' && orderRequest.side !== 'BUY') return { allowed: false, reason: 'INVALID_ORDER_SIDE' };

        const tech = checkTechnicalHealth(nowMs);
        if (!isExitOrder && !tech.ok) return { allowed: false, reason: tech.reason };
        if (orderRequest.orderType !== 'LIMIT' && orderRequest.orderType !== 'SL') return { allowed: false, reason: 'MARKET_ORDER_FORBIDDEN' };
        if (!isExitOrder && orderRequest.orderType !== 'LIMIT') return { allowed: false, reason: 'ENTRY_MUST_BE_LIMIT' };

        const validQty = isExitOrder
            ? (Number.isInteger(orderRequest.quantity) && orderRequest.quantity > 0 && orderRequest.quantity <= LOT_SIZE)
            : (orderRequest.quantity === LOT_SIZE);
        if (!validQty) return { allowed: false, reason: 'INVALID_ORDER_QUANTITY' };
        // Entries must be a recognised NIFTY option symbol. Exits only need to identify the
        // instrument: a cosmetic symbol-format mismatch must never block getting out.
        const symbolOk = NIFTY_OPT_SYMBOL_REGEX.test(String(orderRequest.symbol || ''));
        if (!symbolOk && !(isExitOrder && orderRequest.instrumentKey)) return { allowed: false, reason: 'INVALID_ORDER_INSTRUMENT' };
        if (!Number.isFinite(orderRequest.limitPrice) || orderRequest.limitPrice <= 0) return { allowed: false, reason: 'INVALID_LIMIT_PRICE' };
        if (orderRequest.orderType === 'SL') {
            if (!Number.isFinite(orderRequest.triggerPrice) || orderRequest.triggerPrice < orderRequest.limitPrice) {
                return { allowed: false, reason: 'INVALID_SL_TRIGGER' };
            }
        }
        if (isExitOrder) return { allowed: true };

        if (orderRequest.limitPrice > MAX_ENTRY_LIMIT_PRICE_RS) return { allowed: false, reason: 'PRICE_CAP_EXCEEDED' };

        // Capital fit: premium plus estimated round-trip charges vs real available funds.
        let available;
        try {
            available = getAvailableCapitalFn ? Number(await getAvailableCapitalFn()) : configCapitalRs;
        } catch (err) {
            await auditLog.append('PRE_SEND_GATE', 'PRE_SEND_REJECTED', 'CAPITAL_LOOKUP_FAILED', { error: String(err && err.message) });
            return { allowed: false, reason: 'CAPITAL_LOOKUP_FAILED' };
        }
        if (!Number.isFinite(available)) return { allowed: false, reason: 'CAPITAL_LOOKUP_FAILED' };
        const charges = calculate2026OptionTradePnl({ entryPrice: orderRequest.limitPrice, exitPrice: orderRequest.limitPrice, quantity: LOT_SIZE }).totalCharges;
        const requiredCapital = +(orderRequest.limitPrice * LOT_SIZE + charges).toFixed(2);
        if (requiredCapital > available) {
            await auditLog.append('PRE_SEND_GATE', 'PRE_SEND_REJECTED', 'INSUFFICIENT_ACCOUNT_CAPITAL', { requiredCapital, available });
            return { allowed: false, reason: 'INSUFFICIENT_ACCOUNT_CAPITAL', requiredCapital, available };
        }

        const { dateKey } = getIstDateKeyAndMinutes(nowMs);
        const day = getDayRecord(dateKey);
        const remainingDailyBudget = +(maxDailyLossRs + day.realizedNetPnl + day.unrealizedNetPnl).toFixed(2);
        const remainingWeeklyBudget = getRemainingWeeklyBudgetRs(day.realizedNetPnl + day.unrealizedNetPnl);

        const refEntryPrice = Number.isFinite(orderRequest.candidatePremium) ? roundTick(orderRequest.candidatePremium + 0.05) : orderRequest.limitPrice;
        const chaserFloor = roundTick(Math.max(0.05, refEntryPrice - planConfig.stopChaserMaxSlippageRs - 0.05));
        const worstLoss = Math.max(
            perTradeRiskRs,
            Math.abs(Math.min(0, calculate2026OptionTradePnl({ entryPrice: refEntryPrice, exitPrice: chaserFloor, quantity: LOT_SIZE }).netPnl))
        );

        if (worstLoss > remainingDailyBudget) {
            await auditLog.append('PRE_SEND_GATE', 'PRE_SEND_REJECTED', 'INSUFFICIENT_DAILY_RISK_BUDGET', { worstLoss, remainingDailyBudget });
            return { allowed: false, reason: 'INSUFFICIENT_DAILY_RISK_BUDGET', worstLoss, remainingDailyBudget };
        }
        if (worstLoss > remainingWeeklyBudget) return { allowed: false, reason: 'INSUFFICIENT_WEEKLY_RISK_BUDGET', worstLoss, remainingWeeklyBudget };

        await auditLog.append('PRE_SEND_GATE', 'PRE_SEND_APPROVED', 'ALL_INVARIANTS_PASSED', { worstLoss, remainingDailyBudget, requiredCapital, available });
        return { allowed: true, worstLoss, remainingDailyBudget };
    }

    async function recordTradeEntry(nowMs) {
        getDayRecord(getIstDateKeyAndMinutes(nowMs).dateKey).tradeCount += 1;
        changed();
    }

    async function updateUnrealizedPnl(nowMs, unrealizedNetPnl) {
        const day = getDayRecord(getIstDateKeyAndMinutes(nowMs).dateKey);
        day.unrealizedNetPnl = +unrealizedNetPnl.toFixed(2);
        if (day.realizedNetPnl + day.unrealizedNetPnl <= -maxDailyLossRs) {
            day.haltedReason = 'HALTED_DAILY_LOSS'; changed();
            return { breached: true, reason: 'HALTED_DAILY_LOSS' };
        }
        return { breached: false };
    }

    async function recordTradeClosed(nowMs, netPnl) {
        const day = getDayRecord(getIstDateKeyAndMinutes(nowMs).dateKey);
        day.unrealizedNetPnl = 0;
        day.realizedNetPnl = +(day.realizedNetPnl + netPnl).toFixed(2);
        if (day.realizedNetPnl <= -maxDailyLossRs) day.haltedReason = 'HALTED_DAILY_LOSS';
        changed();
    }

    function getStateSnapshot(nowMs = getTime()) {
        const { dateKey } = getIstDateKeyAndMinutes(nowMs);
        return Object.freeze({
            mode: getEffectiveMode(nowMs), armedDateKey, telegramConfirmedDateKey,
            emergencyHalted, emergencyHaltReason, reconciliationMismatch, reconciliationReason,
            multiDayHaltReason: evaluateMultiDayState(),
            today: Object.freeze({ ...getDayRecord(dateKey) }),
            completedDays: completedDays.map(d => Object.freeze({ ...d })),
            limits: { maxDailyLossRs, perTradeRiskRs, maxTradesPerDay, maxWeeklyLossRs, configCapitalRs },
            planConfig, planVersionId: planVersionId(planConfig)
        });
    }

    return {
        exportState, importState, getPlanConfig: () => planConfig,
        confirmLiveArmOnTelegram, armMode, disarmToShadow, triggerEmergencyKill, clearEmergencyKill,
        setReconciliationMismatch, clearReconciliationMismatch, recordCompletedDaySummary, finalizeDueSessions,
        clearMultiDayHalt, getEffectiveMode, canOpenNewTrade, validatePreSendOrder,
        recordTradeEntry, updateUnrealizedPnl, recordTradeClosed, checkTechnicalHealth, getStateSnapshot
    };
}

// ---------------------------------------------------------------------------
// Paper engine
// ---------------------------------------------------------------------------
function createPaperTradingEngine({ getTime, riskGovernor, auditLog, onStateChange = () => {} }) {
    let openPosition = null;
    let completedTrades = [];
    let sessionFeed = Object.create(null);   // dateKey -> heartbeat-earned verification
    const seenSignalIds = new Set();
    let tradeSeq = 0;

    function exportState() {
        return JSON.stringify({ v: 1, openPosition, completedTrades, sessionFeed, tradeSeq, seenSignalIds: [...seenSignalIds].slice(-500) });
    }
    function importState(json) {
        const st = typeof json === 'string' ? JSON.parse(json) : json;
        if (!st || st.v !== 1) throw new Error('Unrecognised paper state');
        openPosition = st.openPosition || null;
        completedTrades = Array.isArray(st.completedTrades) ? st.completedTrades : [];
        sessionFeed = Object.assign(Object.create(null), st.sessionFeed || {});
        tradeSeq = st.tradeSeq || 0;
        seenSignalIds.clear();
        for (const id of st.seenSignalIds || []) seenSignalIds.add(id);
    }
    function changed() { try { onStateChange(exportState()); } catch (_) {} }

    // Called on EVERY heartbeat, position or not. A session is verified only if
    // heartbeats started by 09:20, ran to 15:25, never gapped > 2 min, and the
    // technical health check never failed during market hours.
    function noteHeartbeat(nowMs, healthy) {
        const { dateKey, minutesIst } = getIstDateKeyAndMinutes(nowMs);
        if (minutesIst < SESSION_OPEN_MIN_IST) return;
        let s = sessionFeed[dateKey];
        if (minutesIst < SESSION_CLOSE_MIN_IST) {
            if (!s) {
                s = sessionFeed[dateKey] = { dateKey, firstBeatMin: minutesIst, lastBeatMs: nowMs, lastBeatMin: minutesIst, degraded: false, degradedReason: null, feedVerified: false, finalized: false };
                if (minutesIst > SESSION_FIRST_BEAT_DEADLINE_MIN_IST) { s.degraded = true; s.degradedReason = 'STARTED_LATE'; }
            } else if (!s.finalized) {
                if (nowMs - s.lastBeatMs > MAX_HEARTBEAT_GAP_MS && !s.degraded) { s.degraded = true; s.degradedReason = 'HEARTBEAT_GAP'; }
                s.lastBeatMs = nowMs; s.lastBeatMin = minutesIst;
            }
            if (!healthy && !s.degraded) { s.degraded = true; s.degradedReason = 'HEALTH_CHECK_FAILED'; }
            changed();
        } else if (s && !s.finalized) {
            s.finalized = true;
            s.feedVerified = !s.degraded && s.lastBeatMin >= SESSION_LAST_BEAT_MIN_IST;
            if (!s.feedVerified && !s.degradedReason) s.degradedReason = 'STOPPED_EARLY';
            changed();
        }
    }

    function isSessionCleanAndVerified(dateKey) {
        const s = sessionFeed[dateKey];
        return Boolean(s && s.finalized && s.feedVerified === true && !s.degraded);
    }

    function canArmLive() {
        const versionId = planVersionId(riskGovernor.getPlanConfig());
        const cleanTrades = completedTrades.filter(t => t.versionId === versionId && isSessionCleanAndVerified(t.sessionDateKey));
        const uniqueCleanSessions = new Set(cleanTrades.map(t => t.sessionDateKey));
        const totalNetPnl = +(cleanTrades.reduce((a, t) => a + t.netPnl, 0)).toFixed(2);
        if (uniqueCleanSessions.size < GRADUATION_MIN_SESSIONS) return { allowed: false, reason: `Requires >= ${GRADUATION_MIN_SESSIONS} feed-verified sessions (have ${uniqueCleanSessions.size})` };
        if (cleanTrades.length < GRADUATION_MIN_TRADES) return { allowed: false, reason: `Requires >= ${GRADUATION_MIN_TRADES} feed-verified trades (have ${cleanTrades.length})` };
        if (totalNetPnl <= 0) return { allowed: false, reason: `Requires cumulative paper net P&L > ₹0 (have ₹${totalNetPnl.toFixed(2)})` };
        if (riskGovernor.getStateSnapshot().reconciliationMismatch) return { allowed: false, reason: 'Unresolved reconciliation mismatch' };
        return { allowed: true, sessionsCount: uniqueCleanSessions.size, tradesCount: cleanTrades.length, totalNetPnl };
    }

    function getGraduationEvidence() {
        const versionId = planVersionId(riskGovernor.getPlanConfig());
        const bySession = {};
        for (const t of completedTrades.filter(x => x.versionId === versionId)) {
            const b = bySession[t.sessionDateKey] || (bySession[t.sessionDateKey] = { dateKey: t.sessionDateKey, trades: 0, netPnl: 0, verified: isSessionCleanAndVerified(t.sessionDateKey), feed: sessionFeed[t.sessionDateKey] || null });
            b.trades += 1; b.netPnl = +(b.netPnl + t.netPnl).toFixed(2);
        }
        return { versionId, sessions: Object.values(bySession).sort((a, b) => a.dateKey.localeCompare(b.dateKey)), gate: canArmLive() };
    }

    async function evaluateSignalForEntry(signal) {
        const nowMs = getTime();
        if (!signal || !signal.signalId) return { status: 'IGNORED', reason: 'INVALID_SIGNAL' };
        if (seenSignalIds.has(signal.signalId)) return { status: 'BLOCKED', reason: 'DUPLICATE_SIGNAL' };

        const gate = await riskGovernor.canOpenNewTrade({ nowMs, openPositionCount: openPosition ? 1 : 0 });
        if (!gate.allowed) return { status: 'BLOCKED', reason: gate.reason };
        if (signal.quoteStatus !== 'VERIFIED' || !signal.quote || !Number.isFinite(signal.quote.ask)) return { status: 'BLOCKED', reason: 'UNVERIFIED_OPTION_QUOTE' };

        let plan;
        try {
            plan = createFrozenTradePlan({ planId: `PLAN_${signal.signalId}`, signalId: signal.signalId, levelId: signal.levelId, tier: signal.tier || 'A', symbol: signal.contract && signal.contract.symbol, side: signal.side, entryAsk: signal.quote.ask, createdAtMs: nowMs, planConfig: riskGovernor.getPlanConfig() });
        } catch (_) { return { status: 'BLOCKED', reason: 'PLAN_CREATION_FAILED' }; }

        const orderReq = { clientOrderId: `ENTRY_${signal.signalId}`, symbol: plan.symbol, side: 'BUY', orderType: 'LIMIT', quantity: plan.quantity, limitPrice: plan.entryLimitPrice, candidatePremium: signal.quote.ask };
        const preSend = await riskGovernor.validatePreSendOrder(orderReq, nowMs);
        if (!preSend.allowed) return { status: 'BLOCKED', reason: preSend.reason };

        seenSignalIds.add(signal.signalId);
        const { dateKey } = getIstDateKeyAndMinutes(nowMs);
        openPosition = {
            tradeId: `TR_${++tradeSeq}_${signal.signalId}`, versionId: plan.versionId, sessionDateKey: dateKey,
            signalId: signal.signalId, levelId: signal.levelId, tier: plan.tier, symbol: plan.symbol, quantity: plan.quantity, plan,
            entryOrderId: orderReq.clientOrderId, entryFillPrice: roundTick(signal.quote.ask + 0.05), entryFilledAtMs: nowMs,
            lastBid: Number.isFinite(signal.quote.bid) ? signal.quote.bid : null,
            protectiveSlOrder: { orderType: 'SL', side: 'SELL', triggerPrice: plan.stopTriggerPrice, limitPrice: plan.stopLimitFloorPrice, status: 'TRIGGER_PENDING', triggeredAtMs: null },
            status: 'OPEN'
        };
        await riskGovernor.recordTradeEntry(nowMs);
        changed();
        return { status: 'OPENED', position: Object.freeze({ ...openPosition }) };
    }

    async function closeOpenPosition(exitFillPrice, exitReason, nowMs = getTime()) {
        if (!openPosition) return null;
        const pos = openPosition;
        openPosition = null;
        const safeExitPrice = roundTick(Math.max(0.05, exitFillPrice));
        const pnl = calculate2026OptionTradePnl({ entryPrice: pos.entryFillPrice, exitPrice: safeExitPrice, quantity: pos.quantity });
        const closed = Object.freeze({
            tradeId: pos.tradeId, versionId: pos.versionId, sessionDateKey: pos.sessionDateKey,
            signalId: pos.signalId, levelId: pos.levelId, tier: pos.tier, symbol: pos.symbol, quantity: pos.quantity,
            entryFillPrice: pos.entryFillPrice, exitFillPrice: safeExitPrice, entryFilledAtMs: pos.entryFilledAtMs, exitFilledAtMs: nowMs,
            exitReason, grossPnl: pnl.grossPnl, totalCharges: pnl.totalCharges, netPnl: pnl.netPnl, plan: pos.plan, status: 'CLOSED',
            expiryDayTuesday: new Date(pos.entryFilledAtMs + 19800000).getUTCDay() === 2   // NIFTY weekly expiry: review separately
        });
        completedTrades.push(closed);
        await riskGovernor.recordTradeClosed(nowMs, closed.netPnl);
        changed();
        return closed;
    }

    async function onOptionQuote(quote, nowMs = getTime()) {
        if (!openPosition || !quote || quote.symbol !== openPosition.symbol) return null;
        if (!Number.isFinite(quote.bid) || quote.bid <= 0) return null;
        openPosition.lastBid = quote.bid;
        const sl = openPosition.protectiveSlOrder;

        if (quote.bid <= openPosition.plan.stopTriggerPrice && quote.bid >= sl.limitPrice) {
            return closeOpenPosition(roundTick(Math.max(sl.limitPrice, quote.bid - 0.05)), 'STOP_LOSS_SL_TRIGGERED', nowMs);
        }
        if (quote.bid < sl.limitPrice) {
            if (sl.status === 'TRIGGER_PENDING') { sl.status = 'TRIGGERED_UNFILLED_OPEN'; sl.triggeredAtMs = nowMs; }
            if (nowMs - sl.triggeredAtMs >= SL_TRIGGER_UNFILLED_CHASE_MS) {
                return closeOpenPosition(roundTick(Math.max(0.05, quote.bid - 0.10)), 'STOP_LOSS_CHASER_FORCED_EXIT', nowMs);
            }
            return null;
        }
        if (quote.bid >= openPosition.plan.targetLimitPrice) {
            return closeOpenPosition(roundTick(quote.bid - 0.05), 'TARGET_HIT_LIMIT', nowMs);
        }
        const markPnl = calculate2026OptionTradePnl({ entryPrice: openPosition.entryFillPrice, exitPrice: quote.bid, quantity: openPosition.quantity });
        const breach = await riskGovernor.updateUnrealizedPnl(nowMs, markPnl.netPnl);
        if (breach.breached) return closeOpenPosition(roundTick(Math.max(0.05, quote.bid - EXIT_LIMIT_BUFFER_RS)), 'DAILY_LOSS_CAP_FLATTEN', nowMs);
        return null;
    }

    async function stepPositionLifecycle(nowMs) {
        if (!openPosition) return null;
        const sl = openPosition.protectiveSlOrder;
        const bid = Number.isFinite(openPosition.lastBid) ? openPosition.lastBid : null;
        const exitAt = () => roundTick(Math.max(0.05, bid - EXIT_LIMIT_BUFFER_RS));

        if (bid === null) {
            // No quote ever seen for the open contract: cannot price an exit honestly.
            return { status: 'NO_QUOTE_FOR_OPEN_POSITION' };
        }
        if (sl.status === 'TRIGGERED_UNFILLED_OPEN' && nowMs - sl.triggeredAtMs >= SL_TRIGGER_UNFILLED_CHASE_MS) {
            return closeOpenPosition(exitAt(), 'STOP_LOSS_CHASER_FORCED_EXIT', nowMs);
        }
        const tech = riskGovernor.checkTechnicalHealth(nowMs);
        if (!tech.ok) return closeOpenPosition(exitAt(), `CIRCUIT_BREAKER_FLATTEN:${tech.reason}`, nowMs);
        if (nowMs >= openPosition.plan.maxHoldUntilMs) return closeOpenPosition(exitAt(), 'TIME_STOP_30M_LIMIT', nowMs);
        if (getIstDateKeyAndMinutes(nowMs).minutesIst >= EOD_FLATTEN_MINUTES_IST) return closeOpenPosition(exitAt(), 'EOD_1515_FLATTEN_LIMIT', nowMs);
        return null;
    }

    // Exit price comes from a real bid (passed in, or the last one seen). Never the entry price.
    async function emergencyFlattenNow(latestBid, reason = 'EMERGENCY_KILL_FLATTEN', nowMs = getTime()) {
        if (!openPosition) return null;
        const bid = Number.isFinite(latestBid) && latestBid > 0 ? latestBid : openPosition.lastBid;
        if (!Number.isFinite(bid) || bid <= 0) return { refused: true, reason: 'NO_QUOTE_FOR_OPEN_POSITION' };
        return closeOpenPosition(roundTick(Math.max(0.05, bid - EXIT_LIMIT_BUFFER_RS)), reason, nowMs);
    }

    return {
        exportState, importState, noteHeartbeat, isSessionCleanAndVerified, canArmLive, getGraduationEvidence,
        evaluateSignalForEntry, onOptionQuote, stepPositionLifecycle, emergencyFlattenNow,
        getOpenPosition: () => openPosition ? Object.freeze({ ...openPosition, protectiveSlOrder: Object.freeze({ ...openPosition.protectiveSlOrder }) }) : null,
        getCompletedTrades: () => [...completedTrades]
    };
}

module.exports = {
    LOT_SIZE, MAX_ENTRY_LIMIT_PRICE_RS, SL_TRIGGER_UNFILLED_CHASE_MS, MAX_HOLD_MS, MAX_CONSECUTIVE_LOSING_DAYS,
    GRADUATION_MIN_SESSIONS, GRADUATION_MIN_TRADES, EOD_FLATTEN_MINUTES_IST, ENTRY_CUTOFF_MINUTES_IST, NIFTY_OPT_SYMBOL_REGEX,
    DEFAULT_PLAN_CONFIG, resolvePlanConfig, planVersionId,
    roundTick, getIstDateKeyAndMinutes, calculate2026OptionTradePnl, createFrozenTradePlan,
    createDecisionAuditLog, createRiskGovernor, createPaperTradingEngine
};
