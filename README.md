# HELL

NIFTY options paper/live trading system with a risk governor, built for Upstox.

```
npm install
npm test     # 49 tests, broker is a simulator
npm start    # needs the variables in .env.example
```

**Status:** HELL boots, reconciles, and handles Telegram commands, but it **cannot trade yet**. There is no strategy (`engine.js` emits no signals) and no live market-data feed. See `STAGE5_NOTES.md`.
