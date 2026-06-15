/*
  Warnings:

  - You are about to drop the column `globalInstructions` on the `TcsSettings` table. All the data in the column will be lost.
  - You are about to drop the column `serviceCode` on the `TcsSettings` table. All the data in the column will be lost.
  - You are about to drop the column `shipperAddress` on the `TcsSettings` table. All the data in the column will be lost.
  - You are about to drop the column `shipperCity` on the `TcsSettings` table. All the data in the column will be lost.
  - You are about to drop the column `shipperName` on the `TcsSettings` table. All the data in the column will be lost.
  - You are about to drop the column `shipperPhone` on the `TcsSettings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "TcsCostCenter" ADD COLUMN "email" TEXT;
ALTER TABLE "TcsCostCenter" ADD COLUMN "phone" TEXT;
ALTER TABLE "TcsCostCenter" ADD COLUMN "pickupAddress" TEXT;
ALTER TABLE "TcsCostCenter" ADD COLUMN "returnAddress" TEXT;

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
    "costCenterCode" TEXT,
    "tcsAccount" TEXT
);
INSERT INTO "new_TcsSettings" ("accessToken", "accessTokenExpiry", "bearerToken", "connectionStatus", "costCenterCode", "createdAt", "id", "lastApiMessage", "lastAuthAttempt", "lastSuccessfulSync", "password", "shop", "tcsAccount", "updatedAt", "username") SELECT "accessToken", "accessTokenExpiry", "bearerToken", "connectionStatus", "costCenterCode", "createdAt", "id", "lastApiMessage", "lastAuthAttempt", "lastSuccessfulSync", "password", "shop", "tcsAccount", "updatedAt", "username" FROM "TcsSettings";
DROP TABLE "TcsSettings";
ALTER TABLE "new_TcsSettings" RENAME TO "TcsSettings";
CREATE UNIQUE INDEX "TcsSettings_shop_key" ON "TcsSettings"("shop");
CREATE INDEX "TcsSettings_shop_idx" ON "TcsSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
