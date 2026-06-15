-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TcsSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "bearerToken" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessTokenExpiry" DATETIME,
    "connectionStatus" TEXT NOT NULL DEFAULT 'disconnected',
    "lastApiMessage" TEXT,
    "lastAuthAttempt" DATETIME,
    "lastSuccessfulSync" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "shipperName" TEXT,
    "shipperPhone" TEXT,
    "shipperAddress" TEXT,
    "shipperCity" TEXT,
    "tcsAccount" TEXT,
    "globalInstructions" TEXT
);
INSERT INTO "new_TcsSettings" ("accessToken", "accessTokenExpiry", "bearerToken", "connectionStatus", "createdAt", "id", "lastApiMessage", "lastAuthAttempt", "lastSuccessfulSync", "password", "shop", "updatedAt", "username") SELECT "accessToken", "accessTokenExpiry", "bearerToken", "connectionStatus", "createdAt", "id", "lastApiMessage", "lastAuthAttempt", "lastSuccessfulSync", "password", "shop", "updatedAt", "username" FROM "TcsSettings";
DROP TABLE "TcsSettings";
ALTER TABLE "new_TcsSettings" RENAME TO "TcsSettings";
CREATE UNIQUE INDEX "TcsSettings_shop_key" ON "TcsSettings"("shop");
CREATE INDEX "TcsSettings_shop_idx" ON "TcsSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
