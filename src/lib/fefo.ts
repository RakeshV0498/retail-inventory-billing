import { isExpired } from "./dates";

export interface BatchLike {
  id: number;
  expiryDate: string | null;
  /** milli-units */
  quantityAvailable: number;
  createdAt: string;
}

export interface Allocation {
  batchId: number;
  /** milli-units taken from this batch */
  quantity: number;
}

export class StockError extends Error {
  constructor(
    public code: "INSUFFICIENT_STOCK" | "ONLY_EXPIRED_STOCK" | "BATCH_EXPIRED" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

/** Earliest expiry first; batches without expiry last; ties broken by oldest created, then id. */
export function sortFefo<T extends BatchLike>(batches: T[]): T[] {
  return [...batches].sort((a, b) => {
    if (a.expiryDate !== b.expiryDate) {
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      return a.expiryDate < b.expiryDate ? -1 : 1;
    }
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id - b.id;
  });
}

/**
 * Allocate `quantity` (milli-units) across sellable batches using FEFO.
 * Expired batches and empty batches are never used.
 */
export function allocateFefo(batches: BatchLike[], quantity: number, today: string): Allocation[] {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new StockError("INVALID", "Quantity must be positive");

  const withStock = batches.filter((b) => b.quantityAvailable > 0);
  const sellable = sortFefo(withStock.filter((b) => !isExpired(b.expiryDate, today)));

  if (sellable.length === 0) {
    if (withStock.length > 0) {
      throw new StockError("ONLY_EXPIRED_STOCK", "All available stock for this product has expired");
    }
    throw new StockError("INSUFFICIENT_STOCK", "Out of stock");
  }

  const total = sellable.reduce((s, b) => s + b.quantityAvailable, 0);
  if (total < quantity) {
    throw new StockError("INSUFFICIENT_STOCK", `Only ${total / 1000} available (expired stock excluded)`);
  }

  const out: Allocation[] = [];
  let remaining = quantity;
  for (const b of sellable) {
    if (remaining === 0) break;
    const take = Math.min(b.quantityAvailable, remaining);
    out.push({ batchId: b.id, quantity: take });
    remaining -= take;
  }
  return out;
}
