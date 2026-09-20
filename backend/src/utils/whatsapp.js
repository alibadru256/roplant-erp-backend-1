const logger = require('./logger');

/**
 * Real WhatsApp Business (Cloud API) integration — sends via Meta's Graph API. This is
 * genuinely different from the frontend's wa.me click-to-chat link: it can send with no
 * human tapping "Send," and it CAN attach a document (like an invoice PDF) directly.
 *
 * It requires a Meta-verified WhatsApp Business Account, a permanent access token, and a
 * phone number ID — none of which can be created here. Without WHATSAPP_TOKEN and
 * WHATSAPP_PHONE_ID configured, this logs what would have been sent and returns false,
 * exactly like the email utility does, so the rest of the app keeps working either way.
 */
function isConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

async function sendWhatsAppText(toPhone, message) {
  if (!isConfigured()) {
    logger.warn('WhatsApp not sent — Business API not configured', { to: toPhone });
    return false;
  }
  const digits = String(toPhone || '').replace(/\D/g, '');
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: message } }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error('WhatsApp send failed', { to: digits, status: res.status, body });
      return false;
    }
    logger.info('WhatsApp message sent', { to: digits });
    return true;
  } catch (err) {
    logger.error('WhatsApp send error', { to: digits, error: err.message });
    return false;
  }
}

/**
 * Sends a document (e.g. an invoice PDF) by URL — WhatsApp's Cloud API requires the file to
 * already be reachable at a public HTTPS URL (it fetches it itself), so this only works once
 * your PDF endpoints are deployed somewhere with a real public address, not from localhost.
 */
async function sendWhatsAppDocument(toPhone, documentUrl, filename, caption) {
  if (!isConfigured()) {
    logger.warn('WhatsApp document not sent — Business API not configured', { to: toPhone, documentUrl });
    return false;
  }
  const digits = String(toPhone || '').replace(/\D/g, '');
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: digits, type: 'document',
        document: { link: documentUrl, filename, caption },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error('WhatsApp document send failed', { to: digits, status: res.status, body });
      return false;
    }
    logger.info('WhatsApp document sent', { to: digits, documentUrl });
    return true;
  } catch (err) {
    logger.error('WhatsApp document send error', { to: digits, error: err.message });
    return false;
  }
}

module.exports = { isConfigured, sendWhatsAppText, sendWhatsAppDocument };
