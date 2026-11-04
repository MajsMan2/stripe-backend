const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const {
      priceId,
      amount,        // valgfri: beløb i øre, hvis du ikke bruger priceId
      currency = "dkk",
      productName,   // bruges sammen med amount
      customerEmail,
      bubbleUserId,
      companyId,     // Bubble unique id på Company
      orderId,
      successUrl,
      cancelUrl,
    } = req.body;

    if (!orderId || !companyId || !successUrl || !cancelUrl) {
      return res.status(400).json({
        error: "orderId, companyId, successUrl og cancelUrl er påkrævet",
      });
    }
    if (!priceId && !(amount && productName)) {
      return res.status(400).json({ error: "Send enten priceId eller amount + productName" });
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
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
