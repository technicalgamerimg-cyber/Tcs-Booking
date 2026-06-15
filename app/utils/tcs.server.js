import db from "../db.server.js";

const TCS_AUTH_URL =
  "https://ociconnect.tcscourier.com/ecom/api/authentication/token";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const REQUEST_TIMEOUT_MS = 10_000; // 10 seconds

// Normalise ALL-CAPS city/center names from TCS → "Title Case"
function toTitleCase(str) {
  return str
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// TCS API confirmed field names: isactive ("Y"/"N"), isdeleted ("Y"/"N")
function isActiveCostCenter(cc) {
  if (cc.isdeleted === "Y") return false;
  if (cc.isactive === "N") return false;
  return true;
}

// ─── Exported functions ────────────────────────────────────────────────────────

/**
 * Returns only status/metadata fields for the settings page loader.
 * Never returns bearerToken, username, password, or accessToken.
 *
 * @param {string} shop
 * @returns {Promise<{
 *   connectionStatus: string,
 *   accessTokenExpiry: string|null,
 *   lastAuthAttempt: string|null,
 *   lastSuccessfulSync: string|null,
 *   lastApiMessage: string|null,
 *   hasCredentials: boolean,
 * }|null>}
 */
export async function getTcsStatus(shop) {
  const record = await db.tcsSettings.findUnique({
    where: { shop },
    select: {
      connectionStatus: true,
      accessTokenExpiry: true,
      lastAuthAttempt: true,
      lastSuccessfulSync: true,
      lastApiMessage: true,
      costCenterCode: true,
      tcsAccount: true,
      defaultInstructions: true,
    },
  });

  if (!record) return null;

  return {
    connectionStatus: record.connectionStatus,
    accessTokenExpiry: record.accessTokenExpiry?.toISOString() ?? null,
    lastAuthAttempt: record.lastAuthAttempt?.toISOString() ?? null,
    lastSuccessfulSync: record.lastSuccessfulSync?.toISOString() ?? null,
    lastApiMessage: record.lastApiMessage ?? null,
    hasCredentials: true,
    costCenterCode: record.costCenterCode ?? "",
    tcsAccount: record.tcsAccount ?? "",
    defaultInstructions: record.defaultInstructions ?? "",
  };
}

/**
 * Validates credential inputs before any DB write or API call.
 * Throws a descriptive Error if any field is missing or too short.
 *
 * @param {{ bearerToken: string, username: string, password: string }} inputs
 */
export function validateTcsInputs({ bearerToken, username, password, tcsAccount }) {
  if (!bearerToken || bearerToken.trim().length < 10) {
    throw new Error("Bearer Token is required and must be at least 10 characters.");
  }
  if (!username || username.trim().length < 2) {
    throw new Error("Username is required and must be at least 2 characters.");
  }
  if (!password || password.trim().length < 4) {
    throw new Error("Password is required and must be at least 4 characters.");
  }
  if (!tcsAccount || tcsAccount.trim().length < 2) {
    throw new Error("TCS Account Number is required and must be at least 2 characters.");
  }
}

/**
 * Saves TCS credentials to the database (upsert by shop).
 * Resets connectionStatus to "disconnected" on every save.
 *
 * @param {string} shop
 * @param {{ bearerToken: string, username: string, password: string }} credentials
 */
export async function saveTcsCredentials(shop, { bearerToken, username, password, tcsAccount }) {
  if (!bearerToken || !username || !password) {
    throw new Error("All credential fields (bearerToken, username, password) are required.");
  }

  await db.tcsSettings.upsert({
    where: { shop },
    create: {
      shop,
      bearerToken: bearerToken.trim(),
      username: username.trim(),
      password: password.trim(),
      tcsAccount: tcsAccount ? tcsAccount.trim() : "",
      connectionStatus: "disconnected",
    },
    update: {
      bearerToken: bearerToken.trim(),
      username: username.trim(),
      password: password.trim(),
      tcsAccount: tcsAccount ? tcsAccount.trim() : undefined,
      connectionStatus: "disconnected",
      // Clear any stale auth state when credentials change
      accessToken: null,
      accessTokenExpiry: null,
      lastApiMessage: null,
    },
  });
}

export async function saveDefaultCostCenter(shop, { costCenterCode, defaultInstructions }) {
  await db.tcsSettings.update({
    where: { shop },
    data: {
      costCenterCode: costCenterCode.trim(),
      defaultInstructions: defaultInstructions.trim(),
    },
  });
}

export async function getDefaultCostCenterDetails(shop) {
  const settings = await db.tcsSettings.findUnique({
    where: { shop },
    select: { costCenterCode: true },
  });
  if (!settings?.costCenterCode) return null;

  return db.tcsCostCenter.findUnique({
    where: { shop_costCenterCode: { shop, costCenterCode: settings.costCenterCode } },
  });
}

export async function getTcsCities(shop) {
  const rows = await db.tcsCity.findMany({
    where: { shop },
    orderBy: { cityName: "asc" },
  });
  return rows.map((c) => ({ ...c, cityName: toTitleCase(c.cityName) }));
}

export async function getTcsCostCenters(shop) {
  return db.tcsCostCenter.findMany({
    where: { shop },
    orderBy: { costCenterName: "asc" },
  });
}

/**
 * Fetches Cities and Cost Centers from the TCS API and saves them to the DB.
 */
export async function syncTcsData(shop, tcsAccount) {
  if (!tcsAccount) {
    throw new Error("TCS Account Number is required to fetch Cost Centers.");
  }

  // TCS two-token pattern:
  //   Authorization header → static bearerToken (API key)
  //   accesstoken query param → dynamic accessToken (session token)
  const [accessToken, settings] = await Promise.all([
    ensureValidTcsToken(shop),
    db.tcsSettings.findUnique({ where: { shop }, select: { bearerToken: true } }),
  ]);

  if (!settings?.bearerToken) {
    throw new Error("No TCS credentials found. Please reconnect.");
  }

  const { bearerToken } = settings;

  // 1. Fetch Cities
  const citiesRes = await fetch(
    `https://ociconnect.tcscourier.com/ecom/api/setup/citylistbycountry?countrycode=Pk&accesstoken=${encodeURIComponent(accessToken)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    },
  );

  if (!citiesRes.ok) throw new Error(`Failed to fetch cities: ${citiesRes.statusText}`);
  const citiesData = await citiesRes.json();
  let citiesCount = 0;

  if (citiesData.message === "SUCCESS" && Array.isArray(citiesData.data)) {
    const uniqueCities = Array.from(
      new Map(
        citiesData.data
          .filter((c) => c.citycode && c.cityname)
          .map((c) => [
            c.citycode,
            { shop, cityCode: c.citycode, cityName: toTitleCase(c.cityname) },
          ]),
      ).values(),
    );

    // Transaction: delete + insert are atomic — partial state impossible
    await db.$transaction(async (tx) => {
      await tx.tcsCity.deleteMany({ where: { shop } });
      // SQLite has a variable limit; insert in chunks of 500
      for (let i = 0; i < uniqueCities.length; i += 500) {
        await tx.tcsCity.createMany({ data: uniqueCities.slice(i, i + 500) });
      }
    });
    citiesCount = uniqueCities.length;
  }

  // 2. Fetch Cost Centers
  const ccRes = await fetch(
    `https://ociconnect.tcscourier.com/ecom/api/inquiry/costcenterinquiry?accesstoken=${encodeURIComponent(accessToken)}&customerno=${encodeURIComponent(tcsAccount)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    },
  );

  if (!ccRes.ok) throw new Error(`Failed to fetch cost centers: ${ccRes.statusText}`);
  const ccData = await ccRes.json();
  let costCentersCount = 0;

  if (Array.isArray(ccData.detail)) {
    const uniqueCCs = Array.from(
      new Map(
        ccData.detail
          .filter((cc) => cc.costcentercode && isActiveCostCenter(cc))
          .map((cc) => [
            cc.costcentercode,
            {
              shop,
              costCenterCode: cc.costcentercode,
              costCenterName: cc.costcentername ?? "Unnamed",
              costCenterCity: toTitleCase(cc.costcentercity ?? ""),
              phone: cc.phoneno ?? "",
              pickupAddress: cc.pickupaddress ?? "",
              returnAddress: cc.returnaddress ?? "",
              email: cc.email ?? "",
            },
          ]),
      ).values(),
    );

    await db.$transaction(async (tx) => {
      await tx.tcsCostCenter.deleteMany({ where: { shop } });
      await tx.tcsCostCenter.createMany({ data: uniqueCCs });
    });
    costCentersCount = uniqueCCs.length;
  }

  return { success: true, citiesCount, costCentersCount };
}

/**
 * Calls the TCS authentication endpoint using stored credentials.
 * Updates connectionStatus, accessToken, accessTokenExpiry, and
 * lastAuthAttempt in the database regardless of success or failure.
 *
 * @param {string} shop
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function authenticateTcs(shop) {
  const record = await db.tcsSettings.findUnique({
    where: { shop },
    select: {
      bearerToken: true,
      username: true,
      password: true,
    },
  });

  if (!record) {
    throw new Error("No credentials saved. Please enter and save your TCS credentials first.");
  }

  const now = new Date();
  let success = false;
  let message = "Unknown error";
  let accessToken = null;
  let accessTokenExpiry = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      const url = new URL(TCS_AUTH_URL);
      url.searchParams.set("username", record.username);
      url.searchParams.set("password", record.password);

      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${record.bearerToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      message = `TCS API returned HTTP ${response.status}`;
    } else {
      const body = await response.json();
      message = body.message ?? "No message returned";

      if (body.message === "success" && body.accesstoken) {
        success = true;
        accessToken = body.accesstoken;
        if (body.expiry) {
          const parsed = new Date(body.expiry);
          accessTokenExpiry = isNaN(parsed.getTime()) ? null : parsed;
        }
      } else {
        success = false;
        message = body.message ?? "Authentication rejected by TCS";
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      message = "Request timed out after 10 seconds. Check your network or TCS server status.";
    } else {
      message = err.message ?? "Network error";
    }
    success = false;
  }

  // Persist result to DB — always update regardless of outcome
  await db.tcsSettings.update({
    where: { shop },
    data: {
      connectionStatus: success ? "connected" : "error",
      accessToken: success ? accessToken : null,
      accessTokenExpiry: success ? accessTokenExpiry : null,
      lastApiMessage: message,
      lastAuthAttempt: now,
    },
  });

  return { success, message };
}

/**
 * Ensures the shop has a valid, non-expired TCS access token.
 * Automatically refreshes if the token is within 5 minutes of expiry.
 * Throws if the shop is not connected or credentials are missing.
 *
 * Use this at the start of every TCS API call (booking, tracking, labels, etc.)
 *
 * @param {string} shop
 * @returns {Promise<string>} valid accessToken
 */
export async function ensureValidTcsToken(shop) {
  const record = await db.tcsSettings.findUnique({
    where: { shop },
    select: {
      connectionStatus: true,
      accessToken: true,
      accessTokenExpiry: true,
    },
  });

  if (!record || record.connectionStatus !== "connected") {
    throw new Error(
      "TCS is not connected. Go to Settings and authenticate with your TCS credentials.",
    );
  }

  // Refresh if token is expiring within the buffer window
  const now = Date.now();
  const expiry = record.accessTokenExpiry ? new Date(record.accessTokenExpiry).getTime() : 0;

  if (!record.accessToken || expiry - now < TOKEN_REFRESH_BUFFER_MS) {
    const result = await authenticateTcs(shop);
    if (!result.success) {
      throw new Error(`TCS token refresh failed: ${result.message}`);
    }
    // Re-fetch the freshly-stored token
    const fresh = await db.tcsSettings.findUnique({
      where: { shop },
      select: { accessToken: true },
    });
    if (!fresh?.accessToken) {
      throw new Error("TCS token refresh completed but no token was stored.");
    }
    return fresh.accessToken;
  }

  return record.accessToken;
}
