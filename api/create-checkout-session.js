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

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return null;
  let u = value.trim();
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") return null;
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
      amount,        // valgfri: beløb i øre, hvis du ikke bruger priceId
      currency = "dkk",
      productName,   // bruges sammen med amount
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
    if (!priceId && !(amount && productName)) {
      return res.status(400).json({ error: "Send enten priceId eller amount + productName" });
    }

    const successFixed = normalizeUrl(successUrl);
    const cancelFixed = normalizeUrl(cancelUrl);
    if (!successFixed || !cancelFixed) {
      return res.status(400).json({
        error: "successUrl og cancelUrl skal være gyldige adresser, fx https://app.esgreport.dk/payment_success",
        modtaget: { successUrl, cancelUrl },
      });
    }

    const line_items = priceId
      ? [{ price: priceId, quantity: 1 }]
      : [{
          price_data: {
            currency,
            unit_amount: Math.round(Number(amount)),
            product_data: { name: productName },
          },
          quantity: 1,
        }];

    const session = await stripe.checkout.sessions.create({
      mode: "payment", // engangskøb
      line_items,
      customer_email: customerEmail || undefined,
      client_reference_id: orderId,
      metadata: {
        orderId,
        companyId,
        bubbleUserId: bubbleUserId || "",
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
