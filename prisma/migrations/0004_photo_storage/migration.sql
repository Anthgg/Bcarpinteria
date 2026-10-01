-- A016: referencia estable al objeto en Supabase Storage. Solo estructura; no modifica fotografías.
-- AlterTable
ALTER TABLE "ProductionPhoto" ADD COLUMN "storagePath" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProductionPhoto_storagePath_key" ON "ProductionPhoto"("storagePath");
