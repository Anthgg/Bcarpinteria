-- Keep active board reservations and physical inventory invariants enforceable
-- even when a future code path misses the service-level checks.
CREATE UNIQUE INDEX "PieceReservation_one_active_per_piece_idx"
  ON "PieceReservation" ("pieceId")
  WHERE "status" = 'RESERVED';

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_stock_nonnegative_check"
  CHECK ("stock" >= 0);

ALTER TABLE "MaterialPiece"
  ADD CONSTRAINT "MaterialPiece_positive_dimensions_check"
  CHECK ("lengthMm" > 0 AND "widthMm" > 0 AND "thicknessMm" > 0);
