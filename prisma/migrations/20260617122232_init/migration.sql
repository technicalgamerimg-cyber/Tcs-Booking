-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
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
    "tcsConsignmentNo" TEXT,
    "shippingAddress1" TEXT,
    "productSummary" TEXT,
    "bookedAt" TIMESTAMP(3),
    "shopifyFulfillmentId" TEXT,
    "shipmentStatus" TEXT NOT NULL DEFAULT 'BOOKED',
    "shopifyCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TcsSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "bearerToken" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiry" TIMESTAMP(3),
    "connectionStatus" TEXT NOT NULL DEFAULT 'disconnected',
    "lastApiMessage" TEXT,
    "lastAuthAttempt" TIMESTAMP(3),
    "lastSuccessfulSync" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "costCenterCode" TEXT,
    "tcsAccount" TEXT,
    "defaultInstructions" TEXT,
    "storeLogo" TEXT,

    CONSTRAINT "TcsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoadsheetHistory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" TEXT NOT NULL DEFAULT '',
    "shipmentCount" INTEGER NOT NULL DEFAULT 0,
    "totalCod" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ordersSnapshot" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "LoadsheetHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TcsCity" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "cityCode" TEXT NOT NULL,
    "cityName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TcsCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TcsCostCenter" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "costCenterCode" TEXT NOT NULL,
    "costCenterName" TEXT NOT NULL,
    "costCenterCity" TEXT NOT NULL,
    "phone" TEXT,
    "pickupAddress" TEXT,
    "returnAddress" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TcsCostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopifyNumericId_key" ON "Order"("shopifyNumericId");

-- CreateIndex
CREATE INDEX "Order_shop_idx" ON "Order"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "TcsSettings_shop_key" ON "TcsSettings"("shop");

-- CreateIndex
CREATE INDEX "TcsSettings_shop_idx" ON "TcsSettings"("shop");

-- CreateIndex
CREATE INDEX "LoadsheetHistory_shop_generatedAt_idx" ON "LoadsheetHistory"("shop", "generatedAt");

-- CreateIndex
CREATE INDEX "TcsCity_shop_idx" ON "TcsCity"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "TcsCity_shop_cityCode_key" ON "TcsCity"("shop", "cityCode");

-- CreateIndex
CREATE INDEX "TcsCostCenter_shop_idx" ON "TcsCostCenter"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "TcsCostCenter_shop_costCenterCode_key" ON "TcsCostCenter"("shop", "costCenterCode");
