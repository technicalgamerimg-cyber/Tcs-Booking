-- AlterTable
ALTER TABLE "Order" ADD COLUMN "bookedAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "shopifyFulfillmentId" TEXT;
ALTER TABLE "Order" ADD COLUMN "shipmentStatus" TEXT NOT NULL DEFAULT 'BOOKED';
