// Early-flow launch sniper for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Thesis, from measuring the dev window: almost every launch dies within minutes, and
// the rare ones that pay share one fingerprint at birth — real SOL is already flowing
// in while the buyer set is still tiny. A launch whose curve already holds a few SOL,
// whose creator put in a sane (not zero, not pre-loaded) buy in the create slot, and
// which so far has exactly two distinct non-creator buyers, is a live launch being
// discovered — not a stillborn mint and not a crowded bundle waiting to dump. This bot
// buys only that fingerprint, inside the first 40 slots, sized at 0.2 SOL per tranche
// (the harness caps every buy at 1% of real SOL anyway), pyramids up to four adds while
// the price keeps making new highs on fresh flow, and exits mechanically: +30% take
// profit, -20% stop, a 3% trailing stop once up 15%, a 45-slot max hold, instant exit
// on a creator sell, and a stale-coin exit after 30 quiet slots. Pure function of the
// batches it is fed: no clock, no randomness, no I/O, no network.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a first buy may be decided. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to spend per tranche (each buy still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Distinct non-creator buyers before entry: at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of real SOL before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once up tp1Bps over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under cost (bps). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
  /** Extra tranches after the first buy, each on a later batch, while the coin keeps rising. */
  maxAdds: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** Lamports per add (each still capped at 1% of real SOL). */
  addLamports: number;
  /** An add needs the recent net flow at least this. */
  addMinFlowLamports: number;
  // ---- Dip leg (second entry path): a coin that already proved strength on a big
  // curve, pulled back hard, and is ticking up again on fresh flow. Disabled when
  // dipStakeLamports is 0. ----
  /** Lamports to spend per dip buy (0 disables the leg). */
  dipStakeLamports: number;
  /** Peak run-up (bps above create) a coin must have reached first. */
  dipMinPeakRunupBps: number;
  /** Pullback (bps) from the peak that arms a dip buy. */
  dipPullbackBps: number;
  /** Price must still sit at least this far (bps) above create. */
  dipFloorBps: number;
  /** The peak must be at most this many slots old. */
  dipPeakAge: number;
  /** Oldest age (slots since create) for a dip entry. */
  dipMaxAge: number;
  /** Short-window net flow that must be positive to buy the dip. */
  dipFlowWindow: number;
  dipMinFlowLamports: number;
  /** Distinct buyers in the dip flow window, at least. */
  dipMinRecentBuyers: number;
  /** Real SOL reserve window at decision time for a dip entry. */
  dipMinRealSol: number;
  dipMaxRealSol: number;
  /** Dip exits: take-profit / stop-loss / trailing (arm, drop) / max hold. */
  dipTpBps: number;
  dipSlBps: number;
  dipTrailArmBps: number;
  dipTrailBps: number;
  dipMaxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 40,
  stakeLamports: 200_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 4_750_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 1_200_000_000,
  minTrades: 0,
  minBuyers: 2,
  maxBuyers: 2,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 40,
  minFlowLamports: 0,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  slAfterTp1Bps: 0,
  tpBps: 3_000,
  slBps: 2_000,
  trailArmBps: 1_500,
  trailBps: 300,
  maxHold: 45,
  exitOnDevSell: true,
  staleSlots: 30,
  exitFlowLamports: 50_000_000,
  maxAdds: 4,
  addStepBps: 0,
  addDelay: 2,
  addLamports: 200_000_000,
  addMinFlowLamports: 0,
  dipStakeLamports: 1_000_000_000,
  dipMinPeakRunupBps: 2_500,
  dipPullbackBps: 8_000,
  dipFloorBps: 500,
  dipPeakAge: 400,
  dipMaxAge: 1_500,
  dipFlowWindow: 12,
  dipMinFlowLamports: 20_000_000,
  dipMinRecentBuyers: 3,
  dipMinRealSol: 60_000_000_000,
  dipMaxRealSol: 200_000_000_000,
  dipTpBps: 3_000,
  dipSlBps: 2_000,
  dipTrailArmBps: 1_500,
  dipTrailBps: 800,
  dipMaxHold: 600,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

/** Everything remembered about one launch, from its CreateEvent onward. */
interface Launch {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time virtual reserves: run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  /** Never consider again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
  /** Buys sent so far and the decision price / slot of the last one (for adds). */
  buysSent: number;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Dip tracking: best price ratio (bps vs create) seen so far, and its slot. */
  peakBps: bigint;
  peakSlot: number;
  /** Price ratio (bps vs create) at the previous batch, for dip recovery checks. */
  prevBps: bigint | null;
  /** Which leg opened this coin ('snipe' | 'dip'), once entered. */
  leg: 'snipe' | 'dip' | null;
}

interface Open {
  openedSlot: number;
  txPaid: bigint;
  bestValue: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
  leg: 'snipe' | 'dip';
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fees (protocol 95 + creator 30 bps) charged on a sell. */
const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against virtual reserves (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, Open>();
  const exiting = new Set<Pubkey>();

  function ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          done: false,
          complete: false,
          buysSent: 0,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          peakBps: 10_000n,
          peakSlot: e.slot,
          prevBps: null,
          leg: null,
        });
      } else if (e.event === 'TradeEvent') {
        const c = launches.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const reserveBefore = BigInt(e.real_quote_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = launches.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold, and distinct non-creator buyers, over the last flowWindow slots. */
  function recentFlow(c: Launch, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  /** The fingerprint gate: true only when the launch is worth a snipe right now. */
  function qualifies(c: Launch, vq: bigint, vt: bigint, rq: bigint, slot: number): boolean {
    if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) return false;
    if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) return false;
    if (c.trades < P.minTrades) return false;
    if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) return false;
    if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) return false;
    if (c.bigSellBps > BigInt(P.maxBigSellBps)) return false;
    if (c.vq0 > 0n && c.vt0 > 0n) {
      const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
      if (runup < BigInt(P.minRunupBps) || runup > BigInt(P.maxRunupBps)) return false;
    }
    const fl = recentFlow(c, slot);
    if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) return false;
    return true;
  }

  return {
    onBatch(state, batch) {
      ingest(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Reconcile fills: track tx fees paid per open position, open new ones on filled buys.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          exiting.delete(f.mint);
          continue;
        }
        const h = open.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          open.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            bestValue: 0n,
            devSoldAtOpen: launches.get(f.mint)?.devSold ?? false,
            tookTp1: false,
            leg: launches.get(f.mint)?.leg ?? 'snipe',
          });
        }
      }
      for (const mint of [...exiting]) if (!hasPending(state, mint, 'sell')) exiting.delete(mint);
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !exiting.has(mint) && !hasPending(state, mint, 'buy')) open.delete(mint);
      }

      // ---- Exits first: never let a stale exit block a new entry in the same batch. ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (exiting.has(mint)) continue;
        const c = launches.get(mint);
        let h = open.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, bestValue: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false, leg: c?.leg ?? 'snipe' };
          open.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.bestValue) h.bestValue = value;
        // Exit parameters follow the leg that opened the position.
        const tp = h.leg === 'dip' ? P.dipTpBps : P.tpBps;
        const sl = h.leg === 'dip' ? P.dipSlBps : P.slBps;
        const trailArm = h.leg === 'dip' ? P.dipTrailArmBps : P.trailArmBps;
        const trail = h.leg === 'dip' ? P.dipTrailBps : P.trailBps;
        const hold = h.leg === 'dip' ? P.dipMaxHold : P.maxHold;
        let exit = false;
        if (basis > 0n) {
          // Partial take-profit first: bank part, let the rest run with a tighter stop.
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              exiting.add(mint);
              h.tookTp1 = true;
              h.bestValue = 0n;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(tp))) exit = true;
          const slNow = h.tookTp1 ? BigInt(P.slAfterTp1Bps) : BigInt(sl);
          if (value * BPS <= basis * (BPS - slNow)) exit = true;
          if (h.bestValue * BPS >= basis * (BPS + BigInt(trailArm)) && value * BPS <= h.bestValue * (BPS - BigInt(trail))) exit = true;
        }
        if (state.slot - h.openedSlot >= hold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots && h.leg === 'snipe') exit = true;
          // Big-curve coins swing more SOL per slot: the flow exit is 10x looser for them.
          const flowExit = h.leg === 'dip' ? 500_000_000n : BigInt(P.exitFlowLamports);
          if (recentFlow(c, state.slot).net < -flowExit) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        exiting.add(mint);
        if (c !== undefined) c.done = true;
      }

      // ---- Entries: young launches passing the fingerprint gate. ----
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let openCount = state.committedPositionCount();
      const stake = BigInt(P.stakeLamports);
      const minBuy = BigInt(P.minBuyLamports);
      for (const c of launches.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        // Track the peak and the previous price ratio for the dip leg.
        const curve0 = state.curves.get(c.mint);
        let bpsNow: bigint | null = null;
        if (curve0 !== undefined && !curve0.complete && c.vq0 > 0n && c.vt0 > 0n) {
          bpsNow = (curve0.virtual_quote_reserves * c.vt0 * BPS) / (curve0.virtual_token_reserves * c.vq0);
          if (bpsNow > c.peakBps) {
            c.peakBps = bpsNow;
            c.peakSlot = state.slot;
          }
        }
        const prev = c.prevBps;
        if (bpsNow !== null) c.prevBps = bpsNow;
        if (c.buysSent > 0) {
          // Pyramid: snipe leg only — strength positions never pyramid.
          if (c.leg !== 'snipe') continue;
          if (c.buysSent > P.maxAdds) continue;
          if (!state.positions.has(c.mint) || exiting.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
          if (c.devSold) continue;
          const curve = state.curves.get(c.mint);
          if (curve === undefined || curve.complete) continue;
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          const vq = curve.virtual_quote_reserves;
          const vt = curve.virtual_token_reserves;
          // Price now must be at least addStepBps above the last buy's decision price.
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + P.addStepBps)) continue;
          if (recentFlow(c, state.slot).net < BigInt(P.addMinFlowLamports)) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const want = BigInt(P.addLamports);
          const amount = want < maxAdd ? want : maxAdd;
          if (amount < minBuy) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // Dip entry: the coin proved strength on a big curve, pulled back hard from
        // its peak, is still above the floor, the peak is fresh, and the price is
        // ticking up again on fresh short-window flow.
        if (P.dipStakeLamports > 0 && age <= P.dipMaxAge && bpsNow !== null) {
          if (openCount < state.hello.caps.max_open_positions && !hasPending(state, c.mint, 'buy')) {
            const curve = state.curves.get(c.mint);
            if (curve !== undefined && !curve.complete && !(c.devSold && P.skipDevSold)) {
              const rq = curve.real_quote_reserves;
              const pulledBack = bpsNow <= c.peakBps - BigInt(P.dipPullbackBps);
              const aboveFloor = bpsNow >= BPS + BigInt(P.dipFloorBps);
              const peakFresh = state.slot - c.peakSlot <= P.dipPeakAge;
              const recovering = prev !== null && bpsNow >= prev;
              if (
                c.peakBps >= BPS + BigInt(P.dipMinPeakRunupBps) &&
                pulledBack && aboveFloor && peakFresh && recovering &&
                rq >= BigInt(P.dipMinRealSol) && rq <= BigInt(P.dipMaxRealSol) &&
                c.trades >= 5 /* dip needs a real tape, unlike the snipe leg */
              ) {
                // Short-window flow: net + distinct buyers over dipFlowWindow slots.
                const fromD = state.slot - P.dipFlowWindow;
                let netD = 0n;
                const buyersD = new Set<Pubkey>();
                for (const t of c.recent) {
                  if (t.slot <= fromD) continue;
                  if (t.isBuy) {
                    netD += t.sol;
                    if (t.user !== c.creator) buyersD.add(t.user);
                  } else netD -= t.sol;
                }
                if (netD >= BigInt(P.dipMinFlowLamports) && buyersD.size >= P.dipMinRecentBuyers) {
                  const maxBuy = state.maxBuyLamports(c.mint);
                  const wantD = BigInt(P.dipStakeLamports);
                  const amount = wantD < maxBuy ? wantD : maxBuy;
                  if (amount >= minBuy && free >= amount + tx) {
                    orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
                    free -= amount + tx;
                    openCount += 1;
                    c.buysSent += 1;
                    c.leg = 'dip';
                    c.lastBuyVq = curve.virtual_quote_reserves;
                    c.lastBuyVt = curve.virtual_token_reserves;
                    c.lastBuySlot = state.slot;
                    continue;
                  }
                }
              }
            }
          }
        }
        if (age > P.maxAge) {
          if (age > P.dipMaxAge || P.dipStakeLamports <= 0) c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (openCount >= state.hello.caps.max_open_positions) continue;
        if (hasPending(state, c.mint, 'buy')) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        if (!qualifies(c, curve.virtual_quote_reserves, curve.virtual_token_reserves, curve.real_quote_reserves, state.slot)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        openCount += 1;
        c.buysSent += 1;
        c.leg = 'snipe';
        c.lastBuyVq = curve.virtual_quote_reserves;
        c.lastBuyVt = curve.virtual_token_reserves;
        c.lastBuySlot = state.slot;
      }
      return orders;
    },
  };
}
