const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { createCustomer, createCheckoutSession, constructWebhookEvent } = require('../services/stripe');

const router = express.Router();

router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, email, stripe_customer_id, subscription_status FROM users WHERE id = $1',
      [req.userId]
    );
    const user = userResult.rows[0];

    if (user.subscription_status === 'active') {
      return res.status(400).json({ error: 'Already subscribed' });
    }

    // Create Stripe customer if needed
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      customerId = await createCustomer(user.email);
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
        customerId,
        user.id,
      ]);
    }

    const frontendUrl = process.env.FRONTEND_URL;
    const session = await createCheckoutSession(
      customerId,
      process.env.STRIPE_PRICE_ID,
      `${frontendUrl}/app.html?session=success`,
      `${frontendUrl}/pricing.html?session=cancelled`
    );

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stripe webhook — must use raw body
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = constructWebhookEvent(req.body, sig);

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const status = subscription.status === 'active' ? 'active' : 'cancelled';
        await pool.query(
          'UPDATE users SET subscription_status = $1 WHERE stripe_customer_id = $2',
          [status, subscription.customer]
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await pool.query(
          "UPDATE users SET subscription_status = 'cancelled' WHERE stripe_customer_id = $1",
          [subscription.customer]
        );
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).json({ error: 'Webhook error' });
  }
});

module.exports = router;
