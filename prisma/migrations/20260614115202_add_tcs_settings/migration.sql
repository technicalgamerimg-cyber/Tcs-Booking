-- CreateTable
CREATE TABLE "TcsSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "bearerToken" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiry" DATETIME,
    "connectionStatus" TEXT NOT NULL DEFAULT 'disconnected',
    "lastApiMessage" TEXT,
    "lastAuthAttempt" DATETIME,
    "lastSuccessfulSync" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "TcsSettings_shop_key" ON "TcsSettings"("shop");

-- CreateIndex
CREATE INDEX "TcsSettings_shop_idx" ON "TcsSettings"("shop");
