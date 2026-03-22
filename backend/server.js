require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { generalLimiter } = require('./middleware/rateLimit');

const authRoutes = require('./routes/auth');
const generateRoutes = require('./routes/generate');
const billingRoutes = require('./routes/billing');
const historyRoutes = require('./routes/history');
const trackerRoutes = require('./routes/tracker');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use(
  cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
  })
);

// Body parsing — skip JSON parsing for Stripe webhook route
app.use((req, res, next) => {
  if (req.originalUrl === '/billing/webhook') {
    next();
  } else {
    express.json({ limit: '1mb' })(req, res, next);
  }
});

// Rate limiting
app.use(generalLimiter);

// Routes
app.use('/auth', authRoutes);
app.use('/generate', generateRoutes);
app.use('/billing', billingRoutes);
app.use('/history', historyRoutes);
app.use('/tracker', trackerRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
