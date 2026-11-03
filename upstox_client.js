'use strict';

// Real Upstox HTTP client. Endpoints and fields follow Upstox's published
// API docs (order place/modify/cancel v3 on api-hft.upstox.com; reads on
// api.upstox.com v2). Request shapes are unit-tested against a fake fetch;
// NONE of this has been exercised against a real Upstox account yet.

const HFT_BASE = 'https://api-hft.upstox.com';
const API_BASE = 'https://api.upstox.com';

class BrokerError extends Error {
    constructor(message, { httpStatus = 0, code = null } = {}) {
        super(message);
        this.name = 'BrokerError';
        this.httpStatus = httpStatus;
        this.code = code;
    }
}

// Upstox order status strings -> HELL states.
function normalizeStatus(s) {
    const v = String(s || '').toLowerCase().trim();
    if (v === 'complete') return 'COMPLETE';
    if (v === 'rejected') return 'REJECTED';
    if (v === 'cancelled') return 'CANCELLED';
    if (v === 'trigger pending') return 'TRIGGER_PENDING';
    if (v === 'open') return 'OPEN';
    return 'PENDING'; // open pending, validation pending, put order req received, modify/cancel pending...
}

function normalizeOrder(o) {
    if (!o) return null;
    return {
        brokerOrderId: String(o.order_id),
        status: normalizeStatus(o.status),
        rawStatus: o.status,
        quantity: Number(o.quantity) || 0,
        filledQty: Number(o.filled_quantity) || 0,
        pendingQty: Number(o.pending_quantity) || 0,
        avgFillPrice: Number(o.average_price) > 0 ? Number(o.average_price) : null,
        limitPrice: Number(o.price) || 0,
        triggerPrice: Number(o.trigger_price) || 0,
        side: String(o.transaction_type || '').toUpperCase(),
        orderType: String(o.order_type || '').toUpperCase(),
        instrumentKey: o.instrument_token || null,
        symbol: o.trading_symbol || o.tradingsymbol || null,
        tag: o.tag || null,
        statusMessage: o.status_message || null
    };
}

function createUpstoxClient({
    fetchFn = globalThis.fetch,
    getAccessToken,             // () => string | null
    algoName,                   // exact Algo Name registered in Upstox My Apps (X-Algo-Name)
    onAuthError = () => {},     // (httpStatus) => void
    product = 'I'               // intraday
}) {
    if (typeof fetchFn !== 'function') throw new Error('fetch is not available (Node 18+ required)');
    if (typeof getAccessToken !== 'function') throw new Error('getAccessToken is required');

    async function request(method, url, { body = null, orderEndpoint = false } = {}) {
        const token = getAccessToken();
        if (!token) {
            onAuthError(401);
            throw new BrokerError('No Upstox access token', { httpStatus: 401 });
        }
        if (orderEndpoint && !algoName) throw new BrokerError('UPSTOX_ALGO_NAME not configured; orders would be rejected');
        const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
        if (body) headers['Content-Type'] = 'application/json';
        if (orderEndpoint) headers['X-Algo-Name'] = algoName;

        let res;
        try {
            res = await fetchFn(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
        } catch (err) {
            throw new BrokerError(`Network error: ${err && err.message}`);
        }
        let json = null;
        try { json = await res.json(); } catch (_) {}
        if (res.status === 401 || res.status === 403) {
            onAuthError(res.status);
            throw new BrokerError(`Upstox auth rejected (${res.status})`, { httpStatus: res.status });
        }
        if (!res.ok || !json || json.status !== 'success') {
            const e = json && Array.isArray(json.errors) && json.errors[0];
            throw new BrokerError(e ? `${e.errorCode || e.error_code}: ${e.message}` : `Upstox HTTP ${res.status}`, { httpStatus: res.status, code: e && (e.errorCode || e.error_code) });
        }
        return json;
    }

    async function placeOrder({ instrumentKey, side, orderType, quantity, limitPrice, triggerPrice = 0, tag }) {
        if (!instrumentKey) throw new BrokerError('instrumentKey required');
        if (orderType !== 'LIMIT' && orderType !== 'SL') throw new BrokerError('Only LIMIT and SL orders allowed');
        const json = await request('POST', `${HFT_BASE}/v3/order/place`, {
            orderEndpoint: true,
            body: {
                quantity, product, validity: 'DAY', price: limitPrice, tag: tag ? String(tag).slice(0, 20) : undefined,
                instrument_token: instrumentKey, order_type: orderType, transaction_type: side,
                disclosed_quantity: 0, trigger_price: orderType === 'SL' ? triggerPrice : 0, is_amo: false, slice: false
            }
        });
        const ids = json.data && json.data.order_ids;
        if (!Array.isArray(ids) || ids.length !== 1) throw new BrokerError('Unexpected place-order response (order_ids)');
        return { brokerOrderId: String(ids[0]) };
    }

    async function modifyOrder(brokerOrderId, { orderType, quantity, limitPrice, triggerPrice = 0 }) {
        await request('PUT', `${HFT_BASE}/v3/order/modify`, {
            orderEndpoint: true,
            body: { order_id: brokerOrderId, quantity, validity: 'DAY', price: limitPrice, order_type: orderType, disclosed_quantity: 0, trigger_price: orderType === 'SL' ? triggerPrice : 0 }
        });
        return { brokerOrderId };
    }

    async function cancelOrder(brokerOrderId) {
        await request('DELETE', `${HFT_BASE}/v3/order/cancel?order_id=${encodeURIComponent(brokerOrderId)}`, { orderEndpoint: true });
        return { brokerOrderId };
    }

    async function getOrder(brokerOrderId) {
        const json = await request('GET', `${API_BASE}/v2/order/details?order_id=${encodeURIComponent(brokerOrderId)}`);
        return normalizeOrder(json.data);
    }

    async function getOrders() {
        const json = await request('GET', `${API_BASE}/v2/order/retrieve-all`);
        return (json.data || []).map(normalizeOrder);
    }

    async function getPositions() {
        const json = await request('GET', `${API_BASE}/v2/portfolio/short-term-positions`);
        return (json.data || []).map(p => ({
            instrumentKey: p.instrument_token,
            symbol: p.trading_symbol || p.tradingsymbol || null,
            netQty: Number(p.quantity) || 0,
            avgEntryPrice: Number(p.buy_price) || Number(p.average_price) || null,
            product: p.product
        }));
    }

    async function getAvailableMargin() {
        const json = await request('GET', `${API_BASE}/v2/user/get-funds-and-margin`);
        const m = json.data && json.data.equity && Number(json.data.equity.available_margin);
        if (!Number.isFinite(m)) throw new BrokerError('available_margin missing from funds response');
        return m;
    }

    async function getProfile() {
        const json = await request('GET', `${API_BASE}/v2/user/profile`);
        return json.data;
    }

    return { placeOrder, modifyOrder, cancelOrder, getOrder, getOrders, getPositions, getAvailableMargin, getProfile };
}

function buildUpstoxLoginUrl({ clientId, redirectUri, state }) {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state });
    return `${API_BASE}/v2/login/authorization/dialog?${q.toString()}`;
}

async function exchangeUpstoxAuthCode({ fetchFn = globalThis.fetch, code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    const res = await fetchFn(`${API_BASE}/v2/login/authorization/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    if (!res.ok || !json || !json.access_token) throw new BrokerError(`Upstox token exchange failed (HTTP ${res.status})`, { httpStatus: res.status });
    return json.access_token;
}

module.exports = { HFT_BASE, API_BASE, BrokerError, normalizeStatus, normalizeOrder, createUpstoxClient, buildUpstoxLoginUrl, exchangeUpstoxAuthCode };
