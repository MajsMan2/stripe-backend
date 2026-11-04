const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function markOrderPaid(session) {
  const { orderId, companyId } = session.metadata || {};
  const resp = await fetch(process.env.BUBBLE_ORDER_PAID_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BUBBLE_API_TOKEN}`,
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
    throw new Error(`Bubble svarede ${resp.status}: ${text}`);
  }
}

const handler = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  let event;
  try {
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(
      raw,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    const session = event.data.object;
    if (
      (event.type === "checkout.session.completed" && session.payment_status === "paid") ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await markOrderPaid(session);
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
