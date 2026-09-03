// A 0/1 book is an empty book. Both venues quote an untraded market
// that way, and taking it literally rendered "widest book 100.0pt"
// beside a leg that said "no executable price", and a fabricated 50%
// mid as the venue's price.
import { realBook, complementBook } from "../lib/fees.js";

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
}

const EMPTY = { bid: null, ask: null };

// The case from production: Toronto vs Cleveland, polymarket.com leg.
check("0/1 is empty", realBook(0, 1), EMPTY);
check("0/1 as strings", realBook("0", "1"), EMPTY);
// Wider than the range is still empty, not a 120pt book.
check("beyond the range", realBook(-0.1, 1.2), EMPTY);

// ONE-SIDED BOOKS SURVIVE. A real bid with nothing offered is a fact
// about the market, not an absence of one, and nulling it would throw
// away a price somebody is actually showing.
check("bid only", realBook(0.4, 1), { bid: 0.4, ask: 1 });
check("ask only", realBook(0, 0.6), { bid: 0, ask: 0.6 });

// Ordinary books pass through untouched, including the extremes a
// long shot legitimately trades at.
check("normal", realBook(0.5, 0.51), { bid: 0.5, ask: 0.51 });
check("penny long shot", realBook(0.01, 0.02), { bid: 0.01, ask: 0.02 });

// Missing values are already absent; realBook must not invent a book.
check("nulls", realBook(null, null), { bid: null, ask: null });
check("undefined", realBook(undefined, undefined), { bid: undefined, ask: undefined });

// The mirror of an empty book is an empty book. markets.js complements
// rawPolyBook rather than the raw row for exactly this reason: reading
// 0/1 through the mirror gives 0/1 back and the emptiness is lost.
const emptied = realBook(0, 1);
check("complement of empty", complementBook(emptied.bid, emptied.ask), EMPTY);
check("complement of raw 0/1 would NOT be empty", complementBook(0, 1), { bid: 0, ask: 1 });

// AN ABSENT BOOK MUST NOT MIRROR INTO A QUOTE. Number(null) is 0, so
// the finite check alone turned a missing book into { bid: 1, ask: 1 }
// — a venue offering to sell at $1.00 that does not exist.
check("complement of nothing", complementBook(null, null), EMPTY);
check("complement of undefined", complementBook(undefined, undefined), EMPTY);
check("complement of empty strings", complementBook("", ""), EMPTY);
check("complement of one missing side", complementBook(0.4, null), EMPTY);
// A genuine zero bid is not a missing bid.
check("complement keeps a real 0 bid", complementBook(0, 0.6), { bid: 0.4, ask: 1 });

console.log(failed ? `${failed} failing` : "real-book: all cases pass");
process.exit(failed ? 1 : 0);
