// Longest auction a seller can start, in days. Shared by POST /api/auctions
// (validation) and AuctionDialog (the duration picker) so the two can't drift.
//
// Why 5: a bid's Stripe hold lasts about 7 days, and after an auction ends
// the seller gets a further 24h decision window (started by the next cron
// run). 5 days + 24h leaves margin for an early bid to still be capturable
// when the seller accepts late; 6 days put the total right at the limit.
export const MAX_AUCTION_DAYS = 5;
