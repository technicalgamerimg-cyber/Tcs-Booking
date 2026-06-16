CREATE TABLE "LoadsheetHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" TEXT NOT NULL DEFAULT '',
    "shipmentCount" INTEGER NOT NULL DEFAULT 0,
    "totalCod" REAL NOT NULL DEFAULT 0,
    "totalWeight" REAL NOT NULL DEFAULT 0,
    "ordersSnapshot" TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX "LoadsheetHistory_shop_generatedAt_idx" ON "LoadsheetHistory"("shop", "generatedAt");
