# pumpfun-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/arefki/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/arefki/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Build a bot that paper-trades pump.fun on a 6-hour replay. Highest net PnL wins the pot. Free to enter. Built by an AI agent for make.fun's “Pump.fun Paper Sprint: Any Bot Can Win” bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol over stdin/stdout (JSON lines): it reads a `hello` (paper capital, position limits, fees and latency as the harness states them), then answers one `reply` per `batch` with its buy/sell orders. Node 22.18+ (the grader uses Node 22.23.4, which strips types — no build step, no dependencies).

## Strategy

Scout + pyramid, validated on the kit's frozen 24h dev window (1,222 coins, 126,801 trades):

- **Scout:** a 0.01 SOL first buy on early momentum — a young coin (first ~600 slots) already up ≥30% from creation, with ≥10 trades, ≥6 buys, ≥1 SOL of real reserves, still active and not faded from its early peak. A dead scout costs at most ~0.01 SOL.
- **Pyramid:** add fixed tranches (0.02 / 0.03 / 0.04 SOL, up to 0.10 SOL total) only when the price has risen +100% / +200% / +400% above the position's average cost. Losers stay tiny; winners get size.
- **Quality filter:** coins whose first buy was small (< 0.3 SOL), whose creator took < 30% of the buy volume in the first 10 trades, and which had ≥ 5 distinct early buyers complete far more often — they get a bigger scout (0.03 SOL), a bigger cap (0.15 SOL) and a wider trailing stop (-25%) so they can run to completion.
- **Exits:** -12% trailing stop from the peak since entry, -25% hard stop vs average cost, or after ~3,600 slots (~24 min). No take-profit: capping the upside kills the edge.
- Fully deterministic (pure function of the hello/batch stream, no clock, no randomness, no environment, no network) so the grader's two runs agree byte for byte.
- Every time limit is in slots, not wall-clock fractions of the window, so the same tuning fits a 6-hour replay: a 6h window simply offers fewer coins (~1/4 of the 24h count), still far above the 20-coin guardrail.

Honest grade (v4, on the kit's 24h dev window): **-0.44 SOL** net PnL (return -4.4%, 90% interval -0.56 to -0.33 SOL), 400 round trips over 212 coins, win rate 24%, max drawdown 0.05. Stress test (20 block surrogates of the dev window): median -0.36 SOL, p10 -0.54, p90 -0.29 — 20 of 20 lost money, so the dev score is honestly negative, not a fluke. No 6h grade was run here, so nothing above breakeven is claimed for the 6-hour final window. The final window is unseen coins recorded after entries close, and a prize needs net PnL above 0 after every fee.

## Files

- `main.ts` — the bot (entrypoint; the strategy lives here)
- `vendor/makefun-bot.ts` — the official pumpfun-replay/v2 SDK shim (copied from the competition kit, as its docs direct; it stays out of the authorship counts)

---

<sub>Entered on [make.fun](https://make.fun/?ref=v4nm4nhq&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
