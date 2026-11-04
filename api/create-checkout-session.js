const Stripe = require("stripe");

async function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }
  if (Buffer.isBuffer(req.body) && req.body.length) {
    return JSON.parse(req.body.toString("utf8"));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

// Kun disse domæner må bruges som success/cancel-adresse
const ALLOWED_HOSTS = (process.env.ALLOWED_RETURN_HOSTS || "app.esgreport.dk")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Tilladte Price-ID'er (komma-separeret, både test og live). Hvis variablen er sat, afvises alle andre.
const ALLOWED_PRICES = (process.env.ALLOWED_PRICE_IDS || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return null;
  let u = value.trim();
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    if (!ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())) return null;
    return u;
  } catch {
    return null;
  }
}

// Live kun hvis testMode eksplicit er "no" / false. Alt andet (også manglende) giver test.
function isTestMode(value) {
  if (value === false) return false;
  const v = String(value ?? "").trim().toLowerCase();
  return !(v === "no" || v === "false" || v === "nej");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Brug POST" });

  try {
    let body;
    try {
      body = await getBody(req);
    } catch {
      return res.status(400).json({ error: "Body er ikke gyldig JSON" });
    }

    const {
      priceId,
      customerEmail,
      bubbleUserId,
      companyId,
      orderId,
      successUrl,
      cancelUrl,
      testMode,
    } = body;

    const test = isTestMode(testMode);
    // Live = de oprindelige variabler, test = variabler med _TEST
    const secretKey = test
      ? process.env.STRIPE_SECRET_KEY_TEST
      : process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return res.status(500).json({
        error: `Mangler ${test ? "STRIPE_SECRET_KEY_TEST" : "STRIPE_SECRET_KEY"} i Vercel`,
      });
    }
    const stripe = new Stripe(secretKey);

    if (!orderId || !companyId || !successUrl || !cancelUrl) {
      return res.status(400).json({
        error: "orderId, companyId, successUrl og cancelUrl er påkrævet",
        modtaget: Object.keys(body),
      });
    }
    if (!priceId || typeof priceId !== "string") {
      return res.status(400).json({ error: "priceId er påkrævet" });
    }
    if (ALLOWED_PRICES.length > 0 && !ALLOWED_PRICES.includes(priceId.trim())) {
      return res.status(400).json({ error: "priceId er ikke tilladt" });
    }

    const successFixed = normalizeUrl(successUrl);
    const cancelFixed = normalizeUrl(cancelUrl);
    if (!successFixed || !cancelFixed) {
      return res.status(400).json({
        error: `successUrl og cancelUrl skal være https-adresser på: ${ALLOWED_HOSTS.join(", ")}`,
        modtaget: { successUrl, cancelUrl },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment", // engangskøb
      line_items: [{ price: priceId.trim(), quantity: 1 }],
      customer_email: customerEmail || undefined,
      client_reference_id: String(orderId),
      metadata: {
        orderId: String(orderId),
        companyId: String(companyId),
        bubbleUserId: bubbleUserId ? String(bubbleUserId) : "",
      },
      success_url: successFixed,
      cancel_url: cancelFixed,
    });

    res.status(200).json({ url: session.url, id: session.id, mode: test ? "test" : "live" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
