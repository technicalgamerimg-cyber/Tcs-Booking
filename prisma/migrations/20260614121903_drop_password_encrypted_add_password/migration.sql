-- SQLite does not support renaming columns directly.
-- We recreate the TcsSettings table replacing passwordEncrypted → password.

PRAGMA foreign_keys=OFF;

CREATE TABLE "TcsSettings_new" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "shop"              TEXT NOT NULL,
    "bearerToken"       TEXT NOT NULL,
    "username"          TEXT NOT NULL,
    "password"          TEXT NOT NULL DEFAULT '',
    "accessToken"       TEXT,
    "accessTokenExpiry" DATETIME,
    "connectionStatus"  TEXT NOT NULL DEFAULT 'disconnected',
    "lastApiMessage"    TEXT,
    "lastAuthAttempt"   DATETIME,
    "lastSuccessfulSync" DATETIME,
    "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         DATETIME NOT NULL
);

-- Copy existing rows; old passwordEncrypted value goes into password column.
-- Merchants will need to re-enter credentials since the value was encrypted.
INSERT INTO "TcsSettings_new"
    ("id","shop","bearerToken","username","password","accessToken",
     "accessTokenExpiry","connectionStatus","lastApiMessage",
     "lastAuthAttempt","lastSuccessfulSync","createdAt","updatedAt")
SELECT
    "id","shop","bearerToken","username","passwordEncrypted","accessToken",
    "accessTokenExpiry","connectionStatus","lastApiMessage",
    "lastAuthAttempt","lastSuccessfulSync","createdAt","updatedAt"
FROM "TcsSettings";

DROP TABLE "TcsSettings";
ALTER TABLE "TcsSettings_new" RENAME TO "TcsSettings";

CREATE UNIQUE INDEX "TcsSettings_shop_key" ON "TcsSettings"("shop");
CREATE INDEX "TcsSettings_shop_idx"        ON "TcsSettings"("shop");

PRAGMA foreign_keys=ON;