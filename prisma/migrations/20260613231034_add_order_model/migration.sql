-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyNumericId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerFirstName" TEXT,
    "customerLastName" TEXT,
    "customerPhone" TEXT,
    "totalAmount" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "city" TEXT,
    "financialStatus" TEXT NOT NULL,
    "fulfillmentStatus" TEXT,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "isBooked" BOOLEAN NOT NULL DEFAULT false,
    "bookingWeight" TEXT,
    "bookingInstructions" TEXT,
    "bookingFreeCod" TEXT,
    "shopifyCreatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopifyNumericId_key" ON "Order"("shopifyNumericId");

-- CreateIndex
CREATE INDEX "Order_shop_idx" ON "Order"("shop");
