# HELL

NIFTY options paper/live trading system with a risk governor, built for Upstox.

```
npm install
npm test     # 55 tests, broker and Upstox feed are simulated
npm start    # needs the variables in .env.example
```

**Status:** HELL boots, reconciles, and handles Telegram commands, but it **cannot trade yet**. Live NIFTY prices come from Upstox (`upstox_feed.js`), but there is no strategy yet (`engine.js` emits no signals). See `STAGE5_NOTES.md`.
