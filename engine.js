'use strict';

// HELL engine: shared constants + the strategy slot.
//
// IMPORTANT: the original 5-minute breakout strategy (Gemini "Pieces 1-4") is
// NOT in this file. Its code was never recovered, and a trading strategy must
// not be guessed. Until a real strategy is plugged in via createRunner({ strategy }),
// HELL uses createNoSignalStrategy(), which never produces a signal, so it cannot
// trade by accident.
//
// Strategy interface (what a real strategy must implement):
//   name: string
//   onSpotTick({ ltp, ts, source }) -> array of signal drafts (may be empty)
//   onOptionQuote(quote) (optional)
// A signal draft is:
//   { signalId, levelId, tier: 'A'|'B'|'C', side: 'BUY', level,
//     contract: { symbol: 'NIFTY26N0425000CE' }, candle: { startMs } }
// The runner adds the live option quote, quoteStatus and the Upstox instrument key.

const MAX_CLOCK_SKEW_MS = 2000;

function createNoSignalStrategy() {
    return Object.freeze({
        name: 'NONE (no strategy loaded)',
        onSpotTick() { return []; },
        onOptionQuote() {}
    });
}

module.exports = { MAX_CLOCK_SKEW_MS, createNoSignalStrategy };
