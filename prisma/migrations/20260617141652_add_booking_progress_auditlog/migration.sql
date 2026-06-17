-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "bookingInProgress" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "shipmentStatus" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_shop_createdAt_idx" ON "AuditLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_shop_orderId_idx" ON "AuditLog"("shop", "orderId");

-- CreateIndex
CREATE INDEX "Order_shop_bookedAt_idx" ON "Order"("shop", "bookedAt");

-- CreateIndex
CREATE INDEX "Order_shop_isCancelled_idx" ON "Order"("shop", "isCancelled");

-- CreateIndex
CREATE INDEX "Order_shop_shipmentStatus_idx" ON "Order"("shop", "shipmentStatus");
