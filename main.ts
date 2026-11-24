/**
 * Paper-trading bot for "Pump.fun Paper Sprint: Any Bot Can Win"
 * (competition u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
 *
 * The house replays this bot over six hours of real pump.fun trading
 * recorded after entries close. The bot with the highest net PnL takes the
 * whole $2 pot, and a prize needs a net PnL above zero once every fee is
 * counted. One program, one file, no dependencies: it reads a hello and a
 * stream of batches on stdin and answers each batch with its orders. The
 * hello supplies the paper capital, the position limits and the fees, so
 * nothing about the starting balance is hardcoded here — the same file
 * trades whatever capital the harness hands it.
 *
 * How it trades — a scout first, then a pyramid, then a hard exit:
 *
 * Most pump.fun coins are noise. On the kit's frozen 24-hour dev window
 * (1,222 coins, 126,801 trades) a quarter of coins touched 2x at some
 * point, yet only about 4% finished above 2x, most coins died within
 * roughly ten minutes, and after any entry the median coin ended at 0.64x
 * within 2,400 slots. Buying at random has no edge: buys and sells come
 * out nearly balanced overall.
 *
 * Two earlier tunings lost money on that same window, and the way they
 * lost taught the shape of this one. Going in at full size on a +25%
 * move with a +60% take-profit and a -25% trail lost 2.94 SOL; going in
 * on +5% with no take-profit and a -6% trail lost 4.60 SOL. Both bled
 * mostly on fees from sizing every position up front. The fix is to
 * start tiny and only add size to positions that have already proved
 * themselves: a 0.01 SOL scout, then fixed adds of 0.02 / 0.03 / 0.04 SOL
 * at +100% / +200% / +400% above the position's average cost, capped at
 * 0.10 SOL per coin. That version lost 0.77 SOL with a 0.08 drawdown —
 * much better, still negative.
 *
 * This version adds one more filter, measured on the same window. Coins
 * whose opening looked organic — a first buy under 0.3 SOL, the creator
 * taking under 30% of the buy volume across the first ten trades, and at
 * least five distinct buyers in those trades — completed far more often
 * (five of the thirty-five completing coins pass; a big first buy or a
 * creator-dominated open almost never completes). Those coins get a
 * bigger scout (0.03 SOL), a bigger cap (0.15 SOL) and a wider trail so
 * they have room to run to completion. The base entry is also stricter
 * than before (+30% gain, at least ten trades, six buys, one SOL of real
 * reserves) to cut the churn behind the earlier loss.
 *
 * Exits are a -12% trailing stop off the peak since entry (-25% for the
 * organic coins), a -25% hard stop against average cost, or a flat exit
 * after about 3,600 slots no matter what. There is no take-profit:
 * capping the upside kills the edge. At most five positions stay open,
 * and a new entry needs at least 0.2 SOL of free cash.
 *
 * Honest numbers for this version, measured on the kit's 24-hour dev
 * window: net PnL -0.44 SOL (a -4.4% return; the 90% interval runs from
 * -0.56 to -0.33 SOL), 400 round trips across 212 coins, a 24% win rate
 * and a 0.05 max drawdown. A stress test over twenty block surrogates of
 * the same window gave a median of -0.36 SOL (p10 -0.54, p90 -0.29) — all
 * twenty lost money, so the dev score is honestly negative rather than a
 * fluke. On a six-hour window the absolute loss should be smaller (fewer
 * trades, less fee churn), and the brief notes that simple strategies
 * beat clever ones on six-hour windows — but no six-hour grade was run
 * here, so nothing above breakeven is claimed. The final window is unseen
 * coins recorded after entries close.
 *
 * Why the slot limits need no change for six hours: every time limit is
 * counted in slots (about 0.4 seconds each), not as a fraction of the
 * window. The entry window (600 slots, about four minutes) and the max
 * hold (3,600 slots, about twenty-four minutes) are coin-lifecycle
 * limits — a coin that has not moved in four minutes, or has been held
 * for twenty-four, behaves the same whether the replay lasts six hours
 * or twenty-four. A six-hour window simply offers fewer coins (about a
 * quarter of the twenty-four-hour count), which is still far above the
 * twenty-coin guardrail.
 *
 * Everything is deterministic: every decision is a pure function of the
 * hello and batch stream, so the grader's two runs agree byte for byte.
 * No clock, no environment, no unseeded randomness, no network, no files,
 * no git history — the bot only reads its hello and its batches.
 */

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning
const SCOUT_LAMPORTS = 10_000_000n; // scout size: 0.01 SOL, also the guardrail floor
const MAX_POSITION_LAMPORTS = 100_000_000n; // ceiling per position: 0.10 SOL
const MIN_BUY_LAMPORTS = 1_000_000n; // smallest buy worth sending: 0.001 SOL
const MIN_ADD_LAMPORTS = 2_000_000n; // smallest add worth sending: 0.002 SOL
const MIN_FREE_CASH_TO_ENTER = 200_000_000n; // free cash needed before a new entry: 0.2 SOL
const ENTRY_GAIN_BPS = 3000; // entry needs +30% over the creation price
const ENTRY_MAX_AGE_SLOTS = 600; // entry only in the first ~4 minutes of a coin's life
const ENTRY_MIN_TRADES = 10; // entry needs at least this many trades so far
const ENTRY_MIN_BUYS = 6; // ...and at least this many of them buys
const ENTRY_MIN_REAL_SOL = 1_000_000_000n; // entry needs >= 1 SOL of real reserves
const ENTRY_FRESH_SLOTS = 90; // the coin's last trade must be within 90 slots
const ENTRY_PEAK_KEEP_BPS = 9500; // price must still be >= 95% of the coin's peak so far
// Pyramid: a tranche goes in only once the price sits this far above average cost.
const PYRAMID_LEVELS: ReadonlyArray<{ gainBps: number; addLamports: bigint }> = [
  { gainBps: 10000, addLamports: 20_000_000n }, // +100% above cost: add 0.02 SOL
  { gainBps: 20000, addLamports: 30_000_000n }, // +200% above cost: add 0.03 SOL
  { gainBps: 40000, addLamports: 40_000_000n }, // +400% above cost: add 0.04 SOL
];
const PYRAMID_MAX_AGE_SLOTS = 2400; // stop adding after ~16 minutes in the position
const TRAILING_BPS = 1200; // trailing stop: -12% off the peak since entry
const STOP_BPS = 2500; // hard stop: -25% against average cost
const MAX_HOLD_SLOTS = 3600; // flat exit after ~24 minutes, whatever the price
const BUY_SLIPPAGE_BPS = 5000; // buys tolerate 50% slippage
const SELL_SLIPPAGE_BPS = 10000; // sells tolerate 100% slippage (a dying coin moves fast)
const MAX_NEW_PER_BATCH = 2; // at most two fresh scouts in one batch
const MAX_ORDERS_PER_BATCH = 16; // hard cap on orders answered per batch
// Organic opens (small first buy, low creator share, many distinct early
// buyers) get more size and more room to run.
const QUALITY_FIRST_BUY_MAX = 300_000_000; // organic first buy: under 0.3 SOL
const QUALITY_CREATOR_MAX_NUM = 30; // creator share under 30/100 of early buy volume
const QUALITY_MIN_BUYERS = 5; // at least five distinct buyers in the first trades
const QUALITY_EVAL_TRADES = 10; // the organic test runs once ten trades are in
const QUALITY_SCOUT_LAMPORTS = 30_000_000n; // organic scout: 0.03 SOL
const QUALITY_MAX_POSITION_LAMPORTS = 150_000_000n; // organic ceiling: 0.15 SOL
const QUALITY_LEVELS: ReadonlyArray<{ gainBps: number; addLamports: bigint }> = [
  { gainBps: 5000, addLamports: 30_000_000n }, // +50% above cost: add 0.03 SOL
  { gainBps: 10000, addLamports: 50_000_000n }, // +100% above cost: add 0.05 SOL
  { gainBps: 20000, addLamports: 60_000_000n }, // +200% above cost: add 0.06 SOL
];
const QUALITY_TRAILING_BPS = 2500; // organic trailing stop: -25% off the peak since entry

// ------------------------------------------------------------------ state
interface Track {
  createPrice: number; // price in SOL per token when the coin was first seen
  peak: number; // highest price seen since the coin was first sighted
  buys: number;
  sells: number;
  lastSlot: number;
  creator: string | null; // from the CreateEvent; null when first seen through a trade
  firstBuySol: number | null; // lamports of the first buy seen (null before any buy)
  buyers: Set<string>; // distinct buyers across the first trades
  buySol: number; // total buy volume in lamports across the first trades
  creatorBuySol: number; // of that volume, bought by the creator
  ntrades: number; // trades seen so far (drives the organic-evaluation point)
  quality: boolean | null; // null = not yet evaluated
}

interface Held {
  entrySlot: number;
  peak: number; // highest price seen since the first fill
  level: number; // pyramid levels already attempted
  quality: boolean;
}

const tracks = new Map<string, Track>();
const held = new Map<string, Held>();

// ------------------------------------------------------------------ helpers
function priceOf(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function minBig(...xs: bigint[]): bigint {
  let m = xs[0];
  for (const x of xs) if (x < m) m = x;
  return m;
}

/** SOL already promised to buys on this mint that have not resolved yet. */
function pendingBuyLamports(state: BotState, mint: string): bigint {
  let total = 0n;
  for (const po of state.pending.values()) {
    if (po.order.side === 'buy' && po.order.mint === mint) {
      total += BigInt(po.order.quote_lamports);
    }
  }
  return total;
}

/** True when a sell for this mint is already sent and not yet resolved. */
function hasPendingSell(state: BotState, mint: string): boolean {
  for (const po of state.pending.values()) {
    if (po.order.side === 'sell' && po.order.mint === mint) return true;
  }
  return false;
}

function newTrack(price: number | null, slot: number, creator: string | null): Track {
  return {
    createPrice: price ?? 0,
    peak: price ?? 0,
    buys: 0,
    sells: 0,
    lastSlot: slot,
    creator,
    firstBuySol: null,
    buyers: new Set<string>(),
    buySol: 0,
    creatorBuySol: 0,
    ntrades: 0,
    quality: null,
  };
}

/** Run the organic test once the first trades are in. */
function evalQuality(t: Track): void {
  if (t.quality !== null) return;
  if (t.ntrades < QUALITY_EVAL_TRADES) return;
  t.quality =
    t.creator !== null &&
    t.firstBuySol !== null &&
    t.firstBuySol < QUALITY_FIRST_BUY_MAX &&
    (t.buySol === 0 || t.creatorBuySol * 100 < t.buySol * QUALITY_CREATOR_MAX_NUM) &&
    t.buyers.size >= QUALITY_MIN_BUYERS;
}

// ------------------------------------------------------------------ the bot
function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  // Cash already promised by buys pushed earlier in THIS batch: the state's
  // free-cash figure does not see them yet, so track them by hand.
  let spentThisBatch = 0n;

  // 1. Fold this batch's events into the per-coin trackers.
  const touched = new Set<string>();
  for (const ev of batch.events) {
    const mint = ev.mint;
    touched.add(mint);
    if (ev.event === 'CreateEvent') {
      if (!tracks.has(mint)) {
        tracks.set(mint, newTrack(priceOf(state, mint), batch.slot, ev.creator));
      }
    } else if (ev.event === 'TradeEvent') {
      let t = tracks.get(mint);
      if (t === undefined) {
        // First seen through a trade: creator unknown, so it can never
        // pass the organic test.
        t = newTrack(priceOf(state, mint), batch.slot, null);
        tracks.set(mint, t);
      }
      t.ntrades += 1;
      if (ev.is_buy) {
        t.buys += 1;
        const sol = Number(ev.sol_amount);
        if (t.firstBuySol === null) t.firstBuySol = sol;
        if (t.ntrades <= QUALITY_EVAL_TRADES) {
          t.buyers.add(ev.user);
          t.buySol += sol;
          if (t.creator !== null && ev.user === t.creator) t.creatorBuySol += sol;
        }
        if (t.ntrades === QUALITY_EVAL_TRADES) evalQuality(t);
      } else {
        t.sells += 1;
        if (t.ntrades === QUALITY_EVAL_TRADES) evalQuality(t);
      }
      const p = priceOf(state, mint);
      if (p !== null && p > t.peak) t.peak = p;
      t.lastSlot = batch.slot;
    } else if (ev.event === 'CompleteEvent') {
      // The harness closes any position in it; stop tracking the coin.
      tracks.delete(mint);
      held.delete(mint);
    }
  }

  // 2. A newly filled buy opens the held record for its coin.
  for (const f of batch.fills) {
    if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
      const p = priceOf(state, f.mint);
      const t = tracks.get(f.mint);
      held.set(f.mint, {
        entrySlot: batch.slot,
        peak: p ?? 0,
        level: 0,
        quality: t !== undefined && t.quality === true,
      });
    }
  }

  // 3. Drop held records whose position is gone (sold, flattened, completed).
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }

  // 4. Exits first: sell everything that hit a rule. Never send a second
  // sell while one is already pending for the mint — the first fills in two
  // slots, and a duplicate only pays another transaction fee before being
  // rejected.
  const sold = new Set<string>();
  for (const [mint, holding] of state.positions) {
    const p = priceOf(state, mint);
    if (p === null || holding.token_amount === 0n) continue;
    const h = held.get(mint);
    const avgCost = Number(holding.cost_lamports) / Number(holding.token_amount);
    if (h !== undefined && p > h.peak) h.peak = p;
    const peak = h !== undefined ? h.peak : p;
    const age = h !== undefined ? batch.slot - h.entrySlot : 0;
    const trailBps = h !== undefined && h.quality ? QUALITY_TRAILING_BPS : TRAILING_BPS;
    const trailing = p <= peak * (1 - trailBps / 10000);
    const stop = p <= avgCost * (1 - STOP_BPS / 10000);
    const stale = h !== undefined && age > MAX_HOLD_SLOTS;
    if ((trailing || stop || stale) && !hasPendingSell(state, mint)) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      sold.add(mint);
    }
  }

  // 5. Scouts and pyramid adds, only for coins that moved in this batch.
  let newEntries = 0;
  for (const mint of touched) {
    if (sold.has(mint)) continue;
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const p = priceOf(state, mint);
    if (p === null) continue;
    const holding = state.positions.get(mint);
    const pendingBuy = pendingBuyLamports(state, mint);
    if (holding !== undefined) {
      // Pyramid: a tranche goes in only once the price sits far enough
      // above the position's average cost. Losers never grow past the scout.
      const h = held.get(mint);
      if (h === undefined) continue;
      const levels = h.quality ? QUALITY_LEVELS : PYRAMID_LEVELS;
      if (h.level >= levels.length) continue;
      const age = batch.slot - h.entrySlot;
      if (age > PYRAMID_MAX_AGE_SLOTS) continue;
      const level = levels[h.level];
      const avgCost = Number(holding.cost_lamports) / Number(holding.token_amount);
      if (p < avgCost * (1 + level.gainBps / 10000)) continue;
      if (p < h.peak * (ENTRY_PEAK_KEEP_BPS / 10000)) continue;
      const maxPos = h.quality ? QUALITY_MAX_POSITION_LAMPORTS : MAX_POSITION_LAMPORTS;
      const remaining = maxPos - holding.cost_lamports - pendingBuy;
      // 95% of the cap: real reserves can dip in the two slots before the
      // fill, and an order over the cap at execution is rejected (fee paid).
      const size = minBig(
        (state.maxBuyLamports(mint) * 95n) / 100n,
        level.addLamports,
        remaining,
        state.freeCashLamports() - spentThisBatch,
      );
      if (size < MIN_ADD_LAMPORTS) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      spentThisBatch += size + state.txFeeLamports();
      h.level += 1;
    } else {
      // Fresh entry: a small scout on early momentum.
      if (newEntries >= MAX_NEW_PER_BATCH) continue;
      // committedPositionCount() does not see the buys already pushed this
      // batch, so count those too — otherwise the five-slot cap can be
      // overshot.
      if (state.committedPositionCount() + newEntries >= 5) continue;
      if (state.freeCashLamports() - spentThisBatch < MIN_FREE_CASH_TO_ENTER) continue;
      const t = tracks.get(mint);
      if (t === undefined) continue;
      const age = batch.slot - (curve.created_slot ?? batch.slot);
      if (age > ENTRY_MAX_AGE_SLOTS) continue;
      if (curve.trades < ENTRY_MIN_TRADES) continue;
      if (t.buys < ENTRY_MIN_BUYS) continue;
      if (curve.real_quote_reserves < ENTRY_MIN_REAL_SOL) continue;
      if (batch.slot - t.lastSlot > ENTRY_FRESH_SLOTS) continue;
      if (p < t.createPrice * (1 + ENTRY_GAIN_BPS / 10000)) continue;
      if (p < t.peak * (ENTRY_PEAK_KEEP_BPS / 10000)) continue;
      const isQuality = t.quality === true;
      const scout = isQuality ? QUALITY_SCOUT_LAMPORTS : SCOUT_LAMPORTS;
      // 95% of the cap, for the same dip-before-fill reason as above.
      const size = minBig(
        (state.maxBuyLamports(mint) * 95n) / 100n,
        scout - pendingBuy,
        state.freeCashLamports() - spentThisBatch,
      );
      if (size < MIN_BUY_LAMPORTS) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      spentThisBatch += size + state.txFeeLamports();
      newEntries += 1;
    }
  }

  // 6. Once in a while, prune stale trackers so memory stays bounded.
  if (batch.seq % 10000 === 0) {
    for (const [mint, t] of tracks) {
      if (!state.positions.has(mint) && batch.slot - t.lastSlot > 20000) {
        tracks.delete(mint);
      }
    }
  }

  return orders;
}

await runBot({ onBatch });
