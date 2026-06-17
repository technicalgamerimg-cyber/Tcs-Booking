import db from "../db.server.js";

const TCS_AUTH_URL =
  "https://ociconnect.tcscourier.com/ecom/api/authentication/token";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const REQUEST_TIMEOUT_MS = 10_000; // 10 seconds

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function writeAudit(shop, action, orderId, details) {
  db.auditLog
    .create({ data: { shop, orderId: orderId ?? null, action, details: JSON.stringify(details) } })
    .catch((err) => console.error("[Audit]", err.message));
}

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
      storeLogo: true,
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
    storeLogo: record.storeLogo ?? null,
  };
}

export async function saveStoreLogo(shop, base64DataUrl) {
  await db.tcsSettings.update({
    where: { shop },
    data: { storeLogo: base64DataUrl },
  });
}

/**
 * Validates credential inputs before any DB write or API call.
 * Throws a descriptive Error if any field is missing or too short.
 *
 * @param {{ bearerToken: string, username: string, password: string }} inputs
 */
export function validateTcsInputs({ bearerToken, username, password, tcsAccount }) {
  if (bearerToken && bearerToken.trim().length < 10) {
    throw new Error("Bearer Token must be at least 10 characters.");
  }
  if (username && username.trim().length < 2) {
    throw new Error("Username must be at least 2 characters.");
  }
  if (password && password.trim().length < 4) {
    throw new Error("Password must be at least 4 characters.");
  }
  if (tcsAccount && tcsAccount.trim().length < 2) {
    throw new Error("TCS Account Number must be at least 2 characters.");
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
  const existing = await db.tcsSettings.findUnique({
    where: { shop },
    select: { bearerToken: true, username: true, password: true, tcsAccount: true },
  });

  const merged = {
    bearerToken: bearerToken?.trim() || existing?.bearerToken || "",
    username:    username?.trim()    || existing?.username    || "",
    password:    password?.trim()    || existing?.password    || "",
    tcsAccount:  tcsAccount?.trim()  || existing?.tcsAccount  || "",
  };

  if (!existing && (!merged.bearerToken || !merged.username || !merged.password)) {
    throw new Error("All credential fields are required for first-time setup.");
  }

  await db.tcsSettings.upsert({
    where: { shop },
    create: {
      shop,
      ...merged,
      connectionStatus: "disconnected",
    },
    update: {
      ...merged,
      connectionStatus: "disconnected",
      accessToken: null,
      accessTokenExpiry: null,
      lastApiMessage: null,
    },
  });
}

export async function saveDefaultCostCenter(shop, { costCenterCode, defaultInstructions, shipperPhone, shipperAddress }) {
  await db.tcsSettings.update({
    where: { shop },
    data: {
      costCenterCode: costCenterCode.trim(),
      defaultInstructions: defaultInstructions.trim(),
    },
  });

  if (costCenterCode.trim()) {
    await db.tcsCostCenter.update({
      where: { shop_costCenterCode: { shop, costCenterCode: costCenterCode.trim() } },
      data: {
        phone:         shipperPhone?.trim()   ?? "",
        pickupAddress: shipperAddress?.trim() ?? "",
      },
    });
  }
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

// ─── Batch helper ─────────────────────────────────────────────────────────────

export async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ─── TCS Booking ──────────────────────────────────────────────────────────────

/**
 * Books a single shipment with TCS. Runs pre-flight validation, calls the
 * Booking Create API, then persists the returned consignment number.
 *
 * @param {string} shop
 * @param {object} order  - full order row from DB (id, shopifyNumericId, name,
 *   customerFirstName, customerLastName, customerPhone, city, shippingAddress1,
 *   financialStatus, totalAmount)
 * @param {{ bookingWeight?: string, bookingInstructions?: string, bookingFreeCod?: string }} opts
 * @returns {Promise<{ consignmentNo: string }>}
 */
export async function bookTcsShipment(shop, order, { bookingWeight, bookingInstructions, bookingFreeCod } = {}) {
  const [accessToken, settings, costCenter] = await Promise.all([
    ensureValidTcsToken(shop),
    db.tcsSettings.findUnique({
      where: { shop },
      select: { bearerToken: true, tcsAccount: true, costCenterCode: true, defaultInstructions: true },
    }),
    getDefaultCostCenterDetails(shop),
  ]);

  // ── Pre-flight checks ─────────────────────────────────────────────────────
  if (!settings?.tcsAccount) throw new Error("TCS account not configured. Go to Settings.");
  if (!settings?.costCenterCode) throw new Error("Default cost center not selected. Go to Settings.");
  if (!costCenter) throw new Error("Default cost center details not found. Re-sync in Settings.");
  if (!order.customerPhone) throw new Error(`Order ${order.name} has no customer phone. Cannot book.`);
  if (!order.city) throw new Error(`Order ${order.name} has no city. Cannot book.`);

  // Atomic claim: only succeeds if not already booked and not in progress
  const claim = await db.order.updateMany({
    where: { id: order.id, isBooked: false, bookingInProgress: false },
    data: { bookingInProgress: true },
  });
  if (claim.count === 0) {
    throw new Error("This order is already being booked or has been booked. Please refresh.");
  }

  const weightKg = Math.max(parseFloat(bookingWeight) || 0.5, 0.5);
  const isPaid = order.financialStatus?.toLowerCase() === "paid";
  const codAmount = isPaid ? 0 : (parseInt(bookingFreeCod || order.totalAmount, 10) || 0);
  const remarks = [bookingInstructions, settings.defaultInstructions]
    .filter(Boolean).join(" | ").slice(0, 500);

  const payload = {
    accesstoken: accessToken,
    shipperinfo: {
      tcsaccount: settings.tcsAccount,
      shippername: costCenter.costCenterName,
      address1: costCenter.pickupAddress || costCenter.costCenterCity,
      countrycode: "PK",
      countryname: "Pakistan",
      cityname: costCenter.costCenterCity,
      mobile: costCenter.phone || "03000000000",
    },
    consigneeinfo: {
      firstname: order.customerFirstName || "Customer",
      middlename: order.customerLastName || " ",
      address1: order.shippingAddress1 || order.city,
      countrycode: "PK",
      countryname: "Pakistan",
      cityname: order.city,
      mobile: order.customerPhone,
    },
    shipmentinfo: {
      costcentercode: settings.costCenterCode,
      servicecode: "O",
      currency: "PKR",
      codamount: codAmount,
      weightinkg: weightKg,
      pieces: 1,
      fragile: false,
      ...(remarks ? { remarks } : {}),
    },
  };

  let consignmentNo = null;
  try {
    const res = await fetchWithTimeout("https://ociconnect.tcscourier.com/ecom/api/booking/create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));

    consignmentNo =
      body.consignmentNo ||
      body.data?.consignmentNo ||
      body.data?.consignmentnumber ||
      body.consignmentnumber ||
      null;

    if (!res.ok || body.status === false || !consignmentNo) {
      throw new Error(body.message || body.data?.message || `TCS booking failed (HTTP ${res.status})`);
    }

    try {
      await db.order.update({
        where: { id: order.id },
        data: {
          isBooked: true,
          tcsConsignmentNo: consignmentNo,
          bookingWeight: String(weightKg),
          bookingInstructions: remarks || null,
          bookingFreeCod: String(codAmount),
          bookedAt: new Date(),
          shipmentStatus: "BOOKED",
          bookingInProgress: false,
        },
      });
      writeAudit(shop, "BOOKED", order.id, { consignmentNo, weightKg, codAmount });
    } catch (dbErr) {
      console.error(`[TCS] DB update failed after booking. CN: ${consignmentNo} | Order: ${order.name}`, dbErr.message);
    }
  } catch (err) {
    // Release the lock so the user can retry
    await db.order.updateMany({
      where: { id: order.id },
      data: { bookingInProgress: false },
    }).catch(() => {});
    throw err;
  }

  return { consignmentNo, remarks };
}

// ─── TCS Label ────────────────────────────────────────────────────────────────

/**
 * Fetches a shipment label from TCS. Returns either raw PDF buffer or a
 * redirect URL depending on what TCS actually returns.
 *
 * @param {string} shop
 * @param {string} consignmentNo
 * @returns {Promise<{ type: "buffer", data: ArrayBuffer } | { type: "url", url: string }>}
 */
export async function getTcsLabel(shop, consignmentNo) {
  const [accessToken, settings] = await Promise.all([
    ensureValidTcsToken(shop),
    db.tcsSettings.findUnique({ where: { shop }, select: { bearerToken: true } }),
  ]);

  const url = new URL("https://ociconnect.tcscourier.com/ecom/api/print/label");
  url.searchParams.set("accesstoken", accessToken);
  url.searchParams.set("consignmentno", consignmentNo);
  url.searchParams.set("shipperDetails", "true");
  url.searchParams.set("printtype", "1");
  url.searchParams.set("accounttype", "1");

  const res = await fetchWithTimeout(url.toString(), {
    headers: { Authorization: `Bearer ${settings.bearerToken}` },
  });

  if (!res.ok) {
    throw new Error(`Label fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";

  // Case 1: raw PDF bytes
  if (contentType.includes("application/pdf") || contentType.includes("octet-stream")) {
    return { type: "buffer", data: await res.arrayBuffer() };
  }

  // Case 2: JSON response — may contain base64 or a URL
  const json = await res.json().catch(() => null);
  if (json) {
    const b64 = json.file || json.filedata || json.pdf || json.content || json.data;
    if (typeof b64 === "string") {
      const binary = Buffer.from(b64, "base64");
      return { type: "buffer", data: binary.buffer };
    }
    const labelUrl = json.url || json.labelUrl;
    if (labelUrl) {
      return { type: "url", url: labelUrl };
    }
  }

  throw new Error("TCS label endpoint returned an unrecognised format.");
}

/**
 * Books multiple orders in batches of 5 concurrent requests.
 * Returns allSettled-style results so one failure doesn't block the rest.
 *
 * @param {string} shop
 * @param {object[]} orders
 * @returns {Promise<PromiseSettledResult[]>}
 */
export async function bookTcsShipmentBulk(shop, orders) {
  return runInBatches(orders, 5, (order) => bookTcsShipment(shop, order, {}));
}

/**
 * Cancels a booked TCS shipment.
 * Endpoint: POST /ecom/api/booking/cancel
 *
 * @param {string} shop
 * @param {string} consignmentNo
 * @returns {Promise<{ success: true }>}
 */
export async function cancelTcsShipment(shop, consignmentNo) {
  const [accessToken, settings] = await Promise.all([
    ensureValidTcsToken(shop),
    db.tcsSettings.findUnique({ where: { shop }, select: { bearerToken: true } }),
  ]);

  const res = await fetchWithTimeout('https://ociconnect.tcscourier.com/ecom/api/booking/cancel', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.bearerToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ consignmentNumber: consignmentNo, accesstoken: accessToken }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok || body.message?.toUpperCase() !== 'SUCCESS') {
    throw new Error(body.message || `TCS cancel failed (HTTP ${res.status})`);
  }

  return { success: true };
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
  const citiesRes = await fetchWithTimeout(
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
      // Insert in chunks of 500 to avoid hitting PostgreSQL parameter limits on large city lists
      for (let i = 0; i < uniqueCities.length; i += 500) {
        await tx.tcsCity.createMany({ data: uniqueCities.slice(i, i + 500) });
      }
    });
    citiesCount = uniqueCities.length;
  }

  // 2. Fetch Cost Centers
  const ccRes = await fetchWithTimeout(
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
    const authUrl = new URL(TCS_AUTH_URL);
    authUrl.searchParams.set("username", record.username);
    authUrl.searchParams.set("password", record.password);

    let response;
    try {
      response = await fetchWithTimeout(authUrl.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${record.bearerToken}`,
          Accept: "application/json",
        },
      });
    } catch (fetchErr) {
      throw fetchErr;
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
