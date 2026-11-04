const Stripe = require("stripe");

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Fjerner "Bearer ", anførselstegn og whitespace, hvis de er kommet med i variablen
function cleanToken(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

// Tjekker signaturen mod både test- og live-secret og finder ud af, hvilket miljø eventet kom fra
function verifyEvent(raw, signature) {
  const candidates = [
    { mode: "test", secret: process.env.STRIPE_WEBHOOK_SECRET_TEST, key: process.env.STRIPE_SECRET_KEY_TEST },
    { mode: "live", secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY },
  ].filter((c) => c.secret);

  if (candidates.length === 0) {
    throw new Error("Ingen STRIPE_WEBHOOK_SECRET eller STRIPE_WEBHOOK_SECRET_TEST sat i Vercel");
  }

  let lastError;
  for (const c of candidates) {
    try {
      const stripe = new Stripe(c.key || "sk_unused");
      const event = stripe.webhooks.constructEvent(raw, signature, c.secret);
      return { event, mode: c.mode };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function markOrderPaid(session, mode) {
  // Live = de oprindelige variabler, test = variabler med _TEST (kun URL'en er forskellig)
  const url = String(
    (mode === "test"
      ? process.env.BUBBLE_ORDER_PAID_URL_TEST
      : process.env.BUBBLE_ORDER_PAID_URL) || ""
  ).trim();

  // Samme Bubble API-token bruges i test og live
  const token = cleanToken(process.env.BUBBLE_API_TOKEN);

  if (!url) {
    throw new Error(`Mangler ${mode === "test" ? "BUBBLE_ORDER_PAID_URL_TEST" : "BUBBLE_ORDER_PAID_URL"} i Vercel`);
  }
  if (!token) throw new Error("Mangler BUBBLE_API_TOKEN i Vercel");

  const { orderId, companyId } = session.metadata || {};

  // Betalinger uden ordre fra vores knap (fx Payment Links) skal ikke sendes til Bubble
  if (!orderId || !companyId) {
    console.log(`Springer ${session.id} over: ingen orderId/companyId i metadata`);
    return;
  }

  console.log(`Kalder Bubble (${mode}): ${url} | token-længde ${token.length}`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      order_id: orderId,
      company: companyId,
      stripe_session_id: session.id,
      payment_intent: session.payment_intent,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bubble (${mode}) svarede ${resp.status}: ${text}`);
  }
}

const handler = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  let event, mode;
  try {
    const raw = await readRaw(req);
    ({ event, mode } = verifyEvent(raw, req.headers["stripe-signature"]));
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    const session = event.data.object;
    if (
      (event.type === "checkout.session.completed" && session.payment_status === "paid") ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await markOrderPaid(session, mode);
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message }); // Stripe prøver igen
  }

  res.status(200).json({ received: true });
};

// Stripe kræver den rå body for at kunne verificere signaturen
handler.config = { api: { bodyParser: false } };
module.exports = handler;
