const nodemailer = require('nodemailer');
const logger = require('./logger');

/**
 * Real email sending via SMTP. This is NOT a mock — when SMTP_HOST/SMTP_USER/SMTP_PASS are
 * set in .env, it genuinely sends mail through your provider (Gmail, SendGrid, Mailgun, your
 * own mail server, etc.). Without them, it logs what WOULD have been sent and returns false,
 * so the rest of the app can still run and you can see exactly what's being triggered before
 * wiring up real credentials.
 */
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendEmail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    logger.warn('Email not sent — SMTP not configured', { to, subject });
    return false;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    logger.info('Email sent', { to, subject });
    return true;
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    return false;
  }
}

// ---- Specific notification triggers, called from the relevant routes ----

async function notifyLowStock(product, ownerEmail) {
  return sendEmail({
    to: ownerEmail,
    subject: `Low stock: ${product.name}`,
    text: `${product.name} (${product.sku}) is down to ${product.stock_qty} units — reorder level is ${product.reorder_level}.`,
  });
}

async function notifyCreditLimitExceeded(customer, ownerEmail) {
  return sendEmail({
    to: ownerEmail,
    subject: `Credit limit exceeded: ${customer.name}`,
    text: `${customer.name} now owes ${customer.balance}, over their credit limit of ${customer.credit_limit}.`,
  });
}

async function notifyUserCreated(newUser, ownerEmail) {
  return sendEmail({
    to: ownerEmail,
    subject: `New user account created: ${newUser.name}`,
    text: `${newUser.name} (${newUser.email}) was added with role ${newUser.role}.`,
  });
}

async function notifyPermissionChange(detail, ownerEmail) {
  return sendEmail({
    to: ownerEmail,
    subject: 'Permission matrix changed',
    text: detail,
  });
}

module.exports = { sendEmail, notifyLowStock, notifyCreditLimitExceeded, notifyUserCreated, notifyPermissionChange };
