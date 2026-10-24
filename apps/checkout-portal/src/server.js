import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQrSvg } from '@youpi/core';
import { getInternalServiceToken } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Security headers applied to every response served by the portal. */
const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'"
});

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Origins allowed to embed the checkout page, from CHECKOUT_FRAME_ANCESTORS
 * (comma or space separated, e.g. "https://shop.example.com"). youpi.js opens the
 * checkout in an iframe on the merchant's own site, which `frame-ancestors 'self'`
 * blocks whenever the store and the portal are on different origins. Anything that
 * is not a plain http(s) origin is ignored, so the CSP cannot be widened by accident.
 */
export function frameAncestorOrigins(raw = process.env.CHECKOUT_FRAME_ANCESTORS) {
  const origins = [];
  for (const entry of String(raw || '').split(/[\s,]+/)) {
    if (!entry) continue;
    try {
      const url = new URL(entry);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && entry.replace(/\/$/, '') === url.origin) {
        origins.push(url.origin);
      }
    } catch {}
  }
  return origins;
}

/**
 * True for production launches. scripts/start.js sets YOUPI_MODE/NODE_ENV to
 * 'production'; the dev script and the test runner leave them on development/test.
 */
export function isProductionLike(env = process.env) {
  return env.YOUPI_MODE === 'production' || env.NODE_ENV === 'production';
}

/**
 * Headers for the embeddable checkout page.
 *
 * The checkout page is embedded cross-origin by merchant storefronts. An explicit
 * CHECKOUT_FRAME_ANCESTORS always wins. Without one, production defaults to
 * frame-ancestors 'self' so unknown sites cannot frame the page, while development
 * stays permissive because the demo storefront (port 5000) embeds the portal
 * (port 7000) across origins. X-Frame-Options is dropped when an allowlist is in
 * effect because it cannot express a list and would block the allowlisted storefronts.
 */
export function checkoutFrameHeaders(env = process.env) {
  const configured = frameAncestorOrigins(env.CHECKOUT_FRAME_ANCESTORS);
  const frameAncestors = configured.length
    ? `'self' ${configured.join(' ')}`
    : (isProductionLike(env) ? "'self'" : '*');
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': `default-src 'self' data: blob:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'self'; object-src 'none'`
  };
}

/**
 * Escapes a value for interpolation into HTML text or attribute context.
 * Order ids, merchant names and branding fields are attacker-influenced, so they must
 * never be injected raw into the checkout template.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Escapes a value for interpolation into a JavaScript string literal.
 * HTML escaping is useless inside <script>: the parser never decodes entities
 * there, so `</script>` and a bare quote would break out of the literal.
 */
export function escapeJsString(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Serialises a value as JSON that is safe to embed in a <script> block.
 * Only `<` matters for tag termination, but U+2028/U+2029 are literal line
 * terminators in older JS parsers, so they are escaped too.
 */
export function serializeForScript(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Placeholders that land inside a <script> block rather than HTML markup.
const SCRIPT_PLACEHOLDERS = new Set(['PAYMENT_ID', 'API_BASE_URL', 'AMOUNT']);

/**
 * Replaces {{PLACEHOLDER}} tokens in the checkout template.
 *
 * The replacement is done with a replacer function so that `$&`, `$'` and `` $` ``
 * inside an attacker-controlled value are inserted literally instead of being
 * expanded as replacement patterns.
 */
export function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    const value = values[key];
    return SCRIPT_PLACEHOLDERS.has(key) ? escapeJsString(value) : escapeHtml(value);
  });
}

/**
 * Strips hop-by-hop and spoofable internal headers before proxying to the payment core.
 * Returns a shallow copy so the caller's request object is never mutated.
 */
function sanitizedForwardHeaders(req, targetHost) {
  const headers = { ...req.headers, host: targetHost };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    // Never let a browser claim to be an internal renderer or replay a credential we issue.
    if (lower === 'x-internal-render' || lower === 'x-internal-token') {
      delete headers[name];
    }
  }
  return headers;
}

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

export class CheckoutServer {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   helpPortalUrl?: string
   * }} options
   */
  constructor(options = {}) {
    try {
      const rootEnv = path.resolve(__dirname, '../../../.env');
      if (fs.existsSync(rootEnv)) {
        const raw = fs.readFileSync(rootEnv, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('BASE_PAYMENT_API_URL=')) {
            const val = trimmed.split('=')[1]?.trim();
            if (val) process.env.BASE_PAYMENT_API_URL = val.replace(/^["']|["']$/g, '');
          }
        }
      }
    } catch {}

    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.htmlTemplatePath = path.join(__dirname, 'views', 'checkout.html');
    this.sdkScriptPath = path.join(__dirname, 'sdk', 'youpi-checkout.js');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  async fetchPaymentState(paymentId) {
    try {
      const internalPort = process.env.PAYMENT_API_PORT || 6100;
      const res = await fetch(`http://127.0.0.1:${internalPort}/api/v1/checkout/${encodeURIComponent(paymentId)}/state`, {
        headers: { 'X-Internal-Render': 'true', 'X-Internal-Token': getInternalServiceToken() }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  loadTemplateWithPartials() {
    try {
      let content = fs.readFileSync(this.htmlTemplatePath, 'utf8');
      const partialsDir = path.resolve(__dirname, 'views', 'partials');
      content = content.replace(/<!--\s*include:partials\/([a-zA-Z0-9_\-.]+)\s*-->/g, (match, filename) => {
        try {
          const partialPath = path.resolve(partialsDir, filename);
          if (partialPath.startsWith(partialsDir) && fs.existsSync(partialPath)) {
            return fs.readFileSync(partialPath, 'utf8');
          }
        } catch {}
        return match;
      });
      return content;
    } catch {
      return this.template || '';
    }
  }

  renderHtml(paymentId, state) {
    let html = this.loadTemplateWithPartials();

    const appName = state?.branding?.appName || 'AR Pay';
    const primaryColor = state?.branding?.primaryColor || '#0b63e5';
    const merchantName = state?.merchantName || 'Merchant Checkout';
    const orderId = state?.orderId || '';
    const logoUrl = state?.branding?.logoUrl || '';
    const sidebarNotice = state?.branding?.sidebarNotice || 'Fast & Secure 256-Bit Encrypted Payments';
    const counterInstructions = state?.branding?.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.';
    const vpa = state?.payeeVpa || state?.vpa || 'mr.kumar.614@superyes';

    // In production and localhost, use relative '' so browser requests hit the checkout portal /api proxy
    // This avoids cross-origin blocking, CORS errors, and tunnel DNS resolution issues.
    const clientApiBase = '';

    const indicator = state?.upiServerIndicator || { status: 'ISSUES', tier: 'RED', label: 'Server Facing Issues' };
    const tier = indicator.tier || (indicator.status === 'WORKING' ? 'GREEN' : (indicator.status === 'BUSY' ? 'YELLOW' : 'RED'));
    const healthClass = tier === 'GREEN' ? 'is-working' : (tier === 'YELLOW' ? 'is-busy' : 'is-issues');
    const healthLabel = indicator.label || (tier === 'GREEN' ? 'Server Is Working' : (tier === 'YELLOW' ? 'UPI Server Busy' : 'Server Facing Issues'));
    const alertStyle = tier === 'GREEN' ? 'none' : 'flex';
    const alertClass = tier === 'YELLOW' ? 'ypg-downtime-alert is-warning' : 'ypg-downtime-alert';
    const alertHeading = tier === 'YELLOW' ? 'UPI Server Busy' : 'UPI Server Facing Issues';
    const alertMsg = indicator.warning || (tier === 'YELLOW'
      ? 'Your payment may go through extra processing seconds.'
      : 'It is not recommended to pay by UPI right now as the server is facing downtime. We recommend paying by cash instead.');

    const sellingMode = state?.sellingMode || state?.branding?.sellingMode || 'ONLINE';
    const enabledMethods = state?.enabledMethods || state?.branding?.enabledPaymentMethods || ['UPI'];
    const showMethodBar = (enabledMethods && enabledMethods.length > 1) ? 'flex' : 'none';
    const tabCodStyle = (sellingMode === 'ONLINE' && enabledMethods.includes('COD')) ? 'display:inline-flex;' : 'display:none;';
    const tabCashStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER')) ? 'display:inline-flex;' : 'display:none;';
    const tabCardStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CARD_COUNTER')) ? 'display:inline-flex;' : 'display:none;';
    const pcCodStyle = (sellingMode === 'ONLINE' && enabledMethods.includes('COD')) ? 'display:block;' : 'display:none;';
    const pcCashStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER')) ? 'display:block;' : 'display:none;';
    const pcCardStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CARD_COUNTER')) ? 'display:block;' : 'display:none;';

    const downtimeAltBtnDisplay = ((sellingMode === 'ONLINE' && enabledMethods.includes('COD')) || (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER'))) ? 'inline-block' : 'none';
    const downtimeAltBtnLabel = (sellingMode === 'ONLINE') ? 'Pay via Cash on Delivery Instead' : 'Pay by Cash at Till Instead';

    return renderTemplate(html, {
      PAYMENT_ID: paymentId,
      API_BASE_URL: clientApiBase,
      APP_NAME: appName,
      PRIMARY_COLOR: primaryColor,
      MERCHANT_NAME: merchantName,
      ORDER_ID: orderId,
      AMOUNT: state?.amount || '0.00',
      VPA: vpa,
      LOGO_URL: logoUrl,
      SIDEBAR_NOTICE: sidebarNotice,
      COUNTER_INSTRUCTIONS: counterInstructions,
      SERVER_HEALTH_CLASS: healthClass,
      SERVER_HEALTH_LABEL: healthLabel,
      DOWNTIME_ALERT_STYLE: alertStyle,
      DOWNTIME_ALERT_CLASS: alertClass,
      DOWNTIME_HEADING: alertHeading,
      DOWNTIME_MSG: alertMsg,
      METHOD_SELECTOR_DISPLAY: showMethodBar,
      TAB_COD_STYLE: tabCodStyle,
      TAB_CASH_STYLE: tabCashStyle,
      TAB_CARD_STYLE: tabCardStyle,
      PC_COD_STYLE: pcCodStyle,
      PC_CASH_STYLE: pcCashStyle,
      PC_CARD_STYLE: pcCardStyle,
      DOWNTIME_ALT_BTN_DISPLAY: downtimeAltBtnDisplay,
      DOWNTIME_ALT_BTN_LABEL: downtimeAltBtnLabel,
      INITIAL_STATE_JSON: serializeForScript(state || {})
    });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'checkout-portal' }));
        return;
      }

      // Keep-alive ping for cron / uptime monitors
      if (pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('ok');
        return;
      }

      // Transparent API Proxy: /api/* -> Payment Core REST API
      if (pathname.startsWith('/api/')) {
        const targetPort = Number(process.env.PAYMENT_API_PORT || 6100);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: {
            ...sanitizedForwardHeaders(req, `localhost:${targetPort}`),
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gateway API unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Download Android Companion APK
      if (pathname === '/youpi-sms-gateway.apk' || pathname === '/download-apk') {
        const apkCandidates = [
          path.resolve(__dirname, '../public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../payment-api/public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../merchant-admin/public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../android-observer-app/youpi-sms-gateway.apk')
        ];
        let apkPath = null;
        for (const p of apkCandidates) {
          if (fs.existsSync(p)) {
            apkPath = p;
            break;
          }
        }
        if (apkPath) {
          const stat = fs.statSync(apkPath);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
            'Content-Length': stat.size,
            'Access-Control-Allow-Origin': '*'
          });
          const stream = fs.createReadStream(apkPath);
          stream.pipe(res);
          return;
        }
      }

      // Official SDK script: GET /youpi.js or /sdk/youpi-checkout.js
      if (pathname === '/youpi.js' || pathname === '/sdk/youpi.js' || pathname === '/sdk/youpi-checkout.js') {
        try {
          const resolvedSdkPath = fs.existsSync(path.join(__dirname, 'sdk', 'youpi.js'))
            ? path.join(__dirname, 'sdk', 'youpi.js')
            : this.sdkScriptPath;
          const sdkContent = fs.readFileSync(resolvedSdkPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(sdkContent);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error loading SDK: ' + err.message);
        }
        return;
      }

      // Static icons: GET /icons/:filename with path traversal protection
      if (pathname.startsWith('/icons/')) {
        const iconName = path.basename(pathname);
        const iconDir = path.resolve(__dirname, '..', 'public', 'icons');
        const iconPath = path.resolve(iconDir, iconName);
        const relative = path.relative(iconDir, iconPath);
        const isSecure = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
        if (isSecure && fs.existsSync(iconPath)) {
          const ext = path.extname(iconName).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(iconPath).pipe(res);
          return;
        }
      }

      // Static CSS & JS Asset Handler with Secure Path Traversal Prevention
      if (pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
        const assetFolder = pathname.startsWith('/css/') ? 'css' : 'js';
        const assetName = path.basename(pathname);
        const assetDir = path.resolve(__dirname, '..', 'public', assetFolder);
        const assetPath = path.resolve(assetDir, assetName);

        const relative = path.relative(assetDir, assetPath);
        const isSecure = relative && !relative.startsWith('..') && !path.isAbsolute(relative);

        if (isSecure && fs.existsSync(assetPath)) {
          const contentType = assetFolder === 'css' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(assetPath).pipe(res);
          return;
        }
      }

      // QR SVG: GET /checkout/:id/qr.svg (Direct from merchant receiving account)
      const qrMatch = pathname.match(/^\/checkout\/([^/]+)\/qr\.svg$/);
      if (qrMatch) {
        const paymentId = qrMatch[1];
        const state = await this.fetchPaymentState(paymentId);
        const upiUri = state?.upiUri || `upi://pay?pa=${encodeURIComponent(state?.payeeVpa || 'mr.kumar.614@superyes')}&pn=${encodeURIComponent(state?.merchantName || 'Store')}&am=${encodeURIComponent(state?.amount || '100.00')}&tn=${encodeURIComponent(paymentId)}`;

        const svg = generateQrSvg(upiUri, 220);
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*',
          ...BASE_SECURITY_HEADERS
        });
        res.end(svg);
        return;
      }

      // Portal Landing Page: GET /
      if (pathname === '/' || pathname === '/index.html') {
        const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YOUPI PG — Checkout Service</title>
  <style>
    :root { --bg: #0d1117; --card-bg: #161b22; --border: #30363d; --text: #f0f6fc; --muted: #8b949e; --primary: #2f81f7; --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font); display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .container { max-width: 520px; width: 90%; background: var(--card-bg); border: 1px solid var(--border); border-radius: 16px; padding: 32px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); text-align: center; }
    .badge { display: inline-flex; align-items: center; gap: 8px; background: rgba(46, 160, 67, 0.15); color: #3fb950; border: 1px solid rgba(46, 160, 67, 0.4); padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 20px; }
    .dot { width: 8px; height: 8px; background: #3fb950; border-radius: 50%; display: inline-block; }
    h1 { font-size: 24px; margin: 0 0 10px; font-weight: 700; }
    p { color: var(--muted); font-size: 14px; line-height: 1.6; margin: 0 0 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; text-align: left; margin-bottom: 24px; }
    .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
    .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-val { font-size: 14px; font-weight: 600; color: var(--text); margin-top: 4px; }
    .actions { display: flex; flex-direction: column; gap: 10px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 20px; border-radius: 8px; font-weight: 600; font-size: 14px; text-decoration: none; transition: all 0.2s; }
    .btn-primary { background: var(--primary); color: #ffffff; }
    .btn-primary:hover { opacity: 0.9; }
    .btn-secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: #21262d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge"><span class="dot"></span> Checkout Engine Active</div>
    <h1>YOUPI PG Checkout Service</h1>
    <p>This is the official payment checkout portal. Merchant payment links (e.g. <code>/checkout/{id}</code>) are processed securely here.</p>
    <div class="grid">
      <div class="stat"><div class="stat-label">Service Status</div><div class="stat-val">Online & Ready</div></div>
      <div class="stat"><div class="stat-label">Protocol</div><div class="stat-val">UPI ISO Vector Engine</div></div>
    </div>
    <div class="actions">
      <a href="/youpi-sms-gateway.apk" class="btn btn-primary">📲 Download Companion APK</a>
      <a href="/youpi.js" class="btn btn-secondary">⚡ Integration SDK (youpi.js)</a>
    </div>
  </div>
</body>
</html>`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          ...BASE_SECURITY_HEADERS
        });
        res.end(landingHtml);
        return;
      }

      // Checkout Page: GET /checkout/:id
      const checkoutMatch = pathname.match(/^\/checkout\/([^/]+)$/);
      if (checkoutMatch) {
        const paymentId = checkoutMatch[1];
        const state = await this.fetchPaymentState(paymentId);

        const rendered = this.renderHtml(paymentId, state);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*',
          ...checkoutFrameHeaders()
        });
        res.end(rendered);
        return;
      }

      // Not found
      const notFoundHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>404 - Page Not Found</title>
  <style>
    body { background: #0d1117; color: #f0f6fc; font-family: system-ui, sans-serif; display: flex; height: 100vh; align-items: center; justify-content: center; margin: 0; }
    .box { text-align: center; max-width: 400px; padding: 2rem; background: #161b22; border: 1px solid #30363d; border-radius: 12px; }
    h1 { color: #f85149; margin-top: 0; }
    a { color: #2f81f7; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <div class="box">
    <h1>404 Not Found</h1>
    <p>The checkout page or endpoint you requested does not exist.</p>
    <a href="/">← Return to Gateway Home</a>
  </div>
</body>
</html>`;
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(notFoundHtml);
    });
  }
}
