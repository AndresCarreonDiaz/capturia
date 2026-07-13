// Idempotent Stripe bootstrap for the Capturia Pro hosted tier (M11, issue
// #10). Creates, or finds and reuses, exactly three objects in TEST mode:
//
//   product  capturia_pro                "Capturia Pro"
//   price    lookup_key capturia_pro_monthly   USD 19 / month
//   meter    event_name capturia_hosted_tokens (sum of value per customer)
//
// Numbers are the issue #10 proposal placeholders ($19/mo, 20 included AI
// hours documented in docs/hosted-tier.md); final pricing is still an open
// owner decision. Run again any time; it never duplicates.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/hosted-setup-stripe.mjs
//   STRIPE_API_BASE=http://localhost:12111 ... (against stripe-mock)
//
// Prints the STRIPE_PRICE_ID env line the checkout endpoint needs.

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("STRIPE_SECRET_KEY is not set (use the sk_test key).");
  process.exit(1);
}
const baseUrl = (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");

const PRODUCT_ID = "capturia_pro";
const PRICE_LOOKUP_KEY = "capturia_pro_monthly";
const METER_EVENT_NAME = "capturia_hosted_tokens"; // = METER_EVENT_NAME in lib/billing/stripe.ts

function encode(params, prefix = "") {
  const pairs = [];
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === "object") pairs.push(encode(value, name));
    else pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.filter(Boolean).join("&");
}

async function stripe(method, path, params = {}) {
  const body = encode(params);
  const url = `${baseUrl}${path}${method === "GET" && body ? `?${body}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(method !== "GET" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method !== "GET" ? { body } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error?.message || `stripe HTTP ${res.status}`);
    err.code = json?.error?.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

async function ensureProduct() {
  try {
    const product = await stripe("GET", `/v1/products/${PRODUCT_ID}`);
    console.log(`product exists: ${product.id}`);
    return product;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const product = await stripe("POST", "/v1/products", {
    id: PRODUCT_ID,
    name: "Capturia Pro",
    description: "Hosted AI tier: 20 included AI hours per month, zero API key setup.",
  });
  console.log(`product created: ${product.id}`);
  return product;
}

async function ensurePrice() {
  const existing = await stripe("GET", "/v1/prices", {
    lookup_keys: { 0: PRICE_LOOKUP_KEY },
    limit: 1,
  });
  if (existing.data?.length) {
    console.log(`price exists: ${existing.data[0].id}`);
    return existing.data[0];
  }
  const price = await stripe("POST", "/v1/prices", {
    product: PRODUCT_ID,
    lookup_key: PRICE_LOOKUP_KEY,
    unit_amount: 1900,
    currency: "usd",
    recurring: { interval: "month" },
  });
  console.log(`price created: ${price.id}`);
  return price;
}

async function ensureMeter() {
  try {
    const meters = await stripe("GET", "/v1/billing/meters", { limit: 100 });
    const found = meters.data?.find((m) => m.event_name === METER_EVENT_NAME);
    if (found) {
      console.log(`meter exists: ${found.id} (${METER_EVENT_NAME})`);
      return found;
    }
  } catch (err) {
    // stripe-mock lacks some billing endpoints; keep the rest of setup useful.
    console.warn(`meter listing unavailable (${err.message}); attempting create`);
  }
  const meter = await stripe("POST", "/v1/billing/meters", {
    display_name: "Capturia hosted tokens",
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: "sum" },
    customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
    value_settings: { event_payload_key: "value" },
  });
  console.log(`meter created: ${meter.id} (${METER_EVENT_NAME})`);
  return meter;
}

const product = await ensureProduct();
const price = await ensurePrice();
await ensureMeter().catch((err) => {
  console.warn(`meter setup failed: ${err.message} (re-run once billing meters are available)`);
});

console.log("");
console.log("# Add to the deployment env:");
console.log(`STRIPE_PRICE_ID=${price.id}`);
console.log(`# product: ${product.id}, meter event: ${METER_EVENT_NAME}`);
