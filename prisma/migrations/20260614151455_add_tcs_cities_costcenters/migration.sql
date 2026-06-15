-- AlterTable
ALTER TABLE "TcsSettings" ADD COLUMN "costCenterCode" TEXT;
ALTER TABLE "TcsSettings" ADD COLUMN "serviceCode" TEXT;

-- CreateTable
CREATE TABLE "TcsCity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "cityCode" TEXT NOT NULL,
    "cityName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TcsCostCenter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "costCenterCode" TEXT NOT NULL,
    "costCenterName" TEXT NOT NULL,
    "costCenterCity" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TcsCity_shop_idx" ON "TcsCity"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "TcsCity_shop_cityCode_key" ON "TcsCity"("shop", "cityCode");

-- CreateIndex
CREATE INDEX "TcsCostCenter_shop_idx" ON "TcsCostCenter"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "TcsCostCenter_shop_costCenterCode_key" ON "TcsCostCenter"("shop", "costCenterCode");
