const Stripe = require('stripe');

let stripe;

function getStripe() {
  if (!stripe) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

async function createCustomer(email) {
  const s = getStripe();
  const customer = await s.customers.create({ email });
  return customer.id;
}

async function createCheckoutSession(customerId, priceId, successUrl, cancelUrl) {
  const s = getStripe();
  const session = await s.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session;
}

function constructWebhookEvent(body, signature) {
  const s = getStripe();
  return s.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { getStripe, createCustomer, createCheckoutSession, constructWebhookEvent };
