-- Depth behind the touch, on the 15-minute price path.
--
-- WHY NOW. Every backtest of this family has printed "fill is not
-- modelled" beside its results, because no row carried a size. That was
-- blamed on Kalshi for weeks ("publishes no depth on this family") and
-- was never Kalshi's: the recorder read `yes_bid_size` where the API
-- sends `yes_bid_size_fp`, and never asked `/orderbook` at all. The
-- touch size now lands in the existing bid_size / ask_size columns from
-- the same /markets response as the price; these columns add what sits
-- behind it.
--
-- WHAT EACH COLUMN MEANS, precisely, because a depth figure read with
-- the wrong definition is worse than none:
--
--   book_bid / book_ask   the best YES bid and best YES ask from the LIVE
--                         order book. PREFER THESE to yes_bid / yes_ask
--                         wherever they are present. The /markets list
--                         the recorder polls is served through a CloudFront
--                         cache (`max-age=15`), so yes_bid / yes_ask can be
--                         up to fifteen seconds old: fired at the same
--                         instant, the list agreed with the book on 1 read
--                         in 48, and quoted KXETH15M at 0.68/0.69 while the
--                         book stood at 0.53/0.54. yes_bid / yes_ask keep
--                         that source so the recorded history stays
--                         like-for-like across this migration.
--   bid_depth_Nc          contracts resting on the YES bid within N cents
--                         of book_bid, INCLUSIVE of the touch level.
--   ask_depth_Nc          the same on the YES offer side, measured from
--                         book_ask. Kalshi publishes NO bids rather than
--                         YES asks; a NO bid at p is a YES offer at 1-p.
--
-- NULL AND ZERO ARE DIFFERENT. Null means the book was not fetched (the
-- request failed, or the row predates this column). Zero means the book
-- was fetched and nothing was resting on that side. A backtest must
-- treat null as "unknown" and never as "empty".
--
-- WHY SUMMARIES AND NOT THE LADDER. A live KXBTC15M book carried 148 and
-- 125 levels. m15_quotes takes ~50k appends a day and is already the
-- table whose index cost drew a disk-IO warning (0024), so six numbers a
-- row is the budget. They answer the two questions a backtest asks —
-- could an order of size S fill near the quoted price, and which side is
-- heavier — and nothing here prevents storing ladders later in a
-- narrower, lower-cadence table if a strategy needs them.
--
-- NO NEW INDEX. Nothing filters on these; they are read alongside rows
-- already located by (ticker, observed_at). Every index here is paid on
-- every insert.
--
-- Nullable, no backfill: every existing row genuinely has no depth, and
-- null says exactly that. Idempotent, like every migration here.

alter table m15_quotes
  add column if not exists book_bid      double precision,
  add column if not exists book_ask      double precision,
  add column if not exists bid_depth_1c  double precision,
  add column if not exists bid_depth_3c  double precision,
  add column if not exists bid_depth_5c  double precision,
  add column if not exists ask_depth_1c  double precision,
  add column if not exists ask_depth_3c  double precision,
  add column if not exists ask_depth_5c  double precision;

comment on column m15_quotes.book_bid is
  'Best YES bid from the LIVE order book. Prefer over yes_bid, which comes through a 15s CDN cache. Null = book not fetched.';
comment on column m15_quotes.bid_depth_1c is
  'Contracts on the YES bid within 1c of book_bid, touch inclusive. Null = book not fetched; 0 = fetched and empty.';
comment on column m15_quotes.ask_depth_1c is
  'Contracts offered on YES (i.e. NO bids, mirrored) within 1c of book_ask, touch inclusive. Null = not fetched; 0 = empty.';
