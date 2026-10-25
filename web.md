# YOUPI PG V2 — Complete Website Integration Guide (web.md)

Yeh guide aapko **YOUPI PG V2** payment gateway ko kisi bhi website (HTML, React, Vue, PHP, Python, Node.js, Next.js, etc.) mein 5 minute mein integrate karne ka poora tarika batati hai.

---

## 🚀 1. Overview (Parichay)

YOUPI PG V2 ek self-hosted, zero-fee UPI payment gateway hai. Isme aapko milta hai:
- **Universal 1-Script Integration**: Direct frontend embedding.
- **Auto Modal Checkout**: Desktop par centered modal aur Mobile par fluid bottom-sheet.
- **Instant UPI Deep-linking**: Google Pay, PhonePe, Paytm, BHIM support.
- **Automated Payment Verification**: Real-time SMS / Gmail / WhatsApp verification.
- **Secure Webhooks**: Server-to-server HMAC-SHA256 signed payment confirmations.

---

## ⚡ 2. Quick Start (1-Line HTML Button Integration)

Sabse aasan tarika apni HTML website mein payment button lagane ka:

### Step 1: Script Add Karein
Apni HTML file ke `<head>` ya `<body>` ke end mein checkout script include karein:

```html
<script
  src="https://checkout.yourdomain.com/youpi.js"
  data-youpi-key="YOUR_MERCHANT_KEY">
</script>
```
*(Local development ke liye `src="http://localhost:7000/youpi.js"` use karein)*

### Step 2: Payment Button Banayein
Apne button element mein `data-youpi-pay` attribute aur payment details add karein:

```html
<button
  data-youpi-pay
  data-amount="499.00"
  data-order-id="ORD-1001"
  data-name="My Store"
  data-description="Pro Membership Plan"
  data-customer-phone="9876543210"
  data-success-url="/success.html"
  data-failed-url="/failed.html">
  Pay ₹499 Now
</button>
```

---

## 📋 3. Button Attributes Reference

Aap HTML button par niche diye gaye attributes use kar sakte hain:

| Attribute | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `data-youpi-pay` | **Yes** | Flags element as a YOUPI checkout trigger | *(boolean attribute)* |
| `data-amount` | **Yes** | Payment amount in INR (Rupees) | `"499"` ya `"499.00"` |
| `data-order-id` | Optional | Unique merchant order ID | `"ORD-9988"` |
| `data-currency` | Optional | Currency code (default: `INR`) | `"INR"` |
| `data-name` | Optional | Merchant / Store display name | `"My Online Shop"` |
| `data-description` | Optional | Product / Order summary | `"Yearly Subscription"` |
| `data-customer-name` | Optional | Customer ka naam | `"Mohit Kumar"` |
| `data-customer-email` | Optional | Customer ka email address | `"customer@example.com"` |
| `data-customer-phone` | Optional | Customer ka mobile number | `"9876543210"` |
| `data-metadata` | Optional | Custom JSON metadata string | `'{"user_id":"usr_123"}'` |
| `data-success-url` | Optional | Payment success hone par redirect URL | `"/payment-success"` |
| `data-failed-url` | Optional | Payment fail hone par redirect URL | `"/payment-failed"` |
| `data-cancelled-url`| Optional | Customer dwara cancel karne par redirect URL | `"/cart"` |
| `data-expired-url` | Optional | Session expire hone par redirect URL | `"/expired"` |

---

## 💻 4. Programmatic JS Integration (`Youpi.pay`)

Agar aap Single Page Application (React, Vue, Angular, Svelte, Next.js) use kar rahe hain ya custom JavaScript handle karna chahte hain:

```javascript
// Ensure script is loaded, then call Youpi.pay
Youpi.pay({
  amount: 499.00,
  order_id: "ORD-2002",
  currency: "INR",
  name: "My App",
  description: "Gold Plan Upgrade",
  customer: {
    name: "Mohit Kumar",
    email: "mohit@example.com",
    phone: "9876543210"
  },
  metadata: {
    plan_id: "plan_gold",
    user_id: "usr_55"
  },
  handler: function(response) {
    console.log("Payment Successful:", response);
    // Response object:
    // {
    //   status: "SUCCESS",
    //   order_id: "ORD-2002",
    //   amount_received: 499.00,
    //   utr: "123456789012",
    //   payment_mode: "UPI"
    // }
    alert("Payment successful! UTR: " + response.utr);
  },
  onFailed: function(response) {
    console.warn("Payment Failed:", response.reason);
    alert("Payment failed: " + response.reason);
  },
  onClose: function() {
    console.log("Customer closed the payment popup");
  }
});
```

---

## 🔔 5. Frontend Browser Events

Script window object par CustomEvents fire karti hai jinse aap APNI frontend UI update kar sakte hain:

```javascript
// 1. Success Event
window.addEventListener('youpi:payment:success', (event) => {
  const { order_id, amount_received, utr, payment_mode } = event.detail;
  console.log(`Payment successful for order ${order_id}! UTR: ${utr}`);
});

// 2. Failed Event
window.addEventListener('youpi:payment:failed', (event) => {
  console.log(`Payment failed for order ${event.detail.order_id}: ${event.detail.reason}`);
});

// 3. Cancelled Event
window.addEventListener('youpi:payment:cancelled', (event) => {
  console.log(`Customer closed order ${event.detail.order_id}`);
});

// 4. Expired Event
window.addEventListener('youpi:payment:expired', (event) => {
  console.log(`Order ${event.detail.order_id} time expired.`);
});
```

> ⚠️ **SECURITY WARNING**: Client-side browser events sirf UI update karne ke liye hote hain. Kisi bhi order ko fullfill karne se pehle **Backend Webhook** verify karein!

---

## 🔐 6. Server-Side Webhook Verification (Authoritative)

Aapka backend server YOUPI PG se HMAC-SHA256 signed webhook receive karega jab payment success hoga.

### Webhook Headers & Payload:
- **Header**: `X-Gateway-Signature: sha256=<hmac_hex_hash>`
- **Header**: `X-Gateway-Event: SUCCESS`
- **Payload**:
```json
{
  "event": "SUCCESS",
  "paymentId": "c7942127-14e3-469a-9e4a-9359a16f903a",
  "orderId": "ORD-1001",
  "amount": "499.00",
  "amountPaise": 49900,
  "currency": "INR",
  "method": "UPI",
  "utr": "123456789012",
  "completedAt": "2026-10-25T10:00:00.000Z",
  "metadata": { "user_id": "usr_123" }
}
```

### Server Verification Implementations:

#### 1. Node.js (Express)
```javascript
import express from 'express';
import crypto from 'node:crypto';

const app = express();

// Important: Parse body as raw buffer for HMAC checking
app.post('/api/webhook/youpi', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-gateway-signature'] || '';
  const secret = process.env.YOUPI_WEBHOOK_SECRET;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('hex');

  // Secure constant-time comparison
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  const payload = JSON.parse(req.body.toString('utf8'));

  if (payload.event === 'SUCCESS') {
    const { orderId, amount, utr, metadata } = payload;
    // Fulfill order in database: mark order as PAID
    console.log(`Order ${orderId} verified with UTR ${utr}`);
  }

  return res.status(200).json({ received: true });
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

#### 2. Python (FastAPI)
```python
import hmac
import hashlib
import json
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()

WEBHOOK_SECRET = "your_webhook_secret_here"

@app.post("/api/webhook/youpi")
async def youpi_webhook(request: Request):
    raw_body = await request.body()
    signature = request.headers.get("X-Gateway-Signature", "")

    expected = "sha256=" + hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        raw_body,
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid signature")

    payload = json.loads(raw_body.decode("utf-8"))
    if payload.get("event") == "SUCCESS":
        order_id = payload.get("orderId")
        utr = payload.get("utr")
        # Mark order as PAID in DB
        print(f"Order {order_id} fulfilled with UTR {utr}")

    return {"received": True}
```

#### 3. PHP
```php
<?php
$rawBody = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_GATEWAY_SIGNATURE'] ?? '';
$secret = getenv('YOUPI_WEBHOOK_SECRET');

$expected = 'sha256=' . hash_hmac('sha256', $rawBody, $secret);

if (!hash_equals($expected, $signature)) {
    http_response_code(401);
    exit(json_encode(['error' => 'Invalid signature']));
}

$payload = json_decode($rawBody, true);

if (($payload['event'] ?? '') === 'SUCCESS') {
    $orderId = $payload['orderId'];
    $utr = $payload['utr'];
    // Fulfill order in DB
}

http_response_code(200);
echo json_encode(['received' => true]);
?>
```

#### 4. Go (`net/http`)
```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
)

func webhookHandler(w http.ResponseWriter, r *http.Request) {
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	signature := r.Header.Get("X-Gateway-Signature")
	secret := []byte(os.Getenv("YOUPI_WEBHOOK_SECRET"))

	mac := hmac.New(sha256.New, secret)
	mac.Write(rawBody)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(signature), []byte(expected)) {
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	var payload struct {
		Event   string `json:"event"`
		OrderId string `json:"orderId"`
		UTR     string `json:"utr"`
	}
	if err := json.Unmarshal(rawBody, &payload); err == nil && payload.Event == "SUCCESS" {
		// Fulfill order
	}

	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"received":true}`))
}
```

---

## 🛠️ 7. Development vs Production Setup

1. **Local Testing**:
   - Gateway Checkout Portal Port: `7000` (`http://localhost:7000/youpi.js`)
   - Gateway API Port: `6100` (`http://localhost:6100`)
   - Merchant Admin Port: `6001` (`http://localhost:6001`)

2. **Production Deployment**:
   - Self-hosted domain par setup karne ke baad `https://checkout.yourdomain.com/youpi.js` se script link karein.
   - Merchant Admin dashboard se apna Webhook Secret copy karein aur backend environment variables mein set karein (`YOUPI_WEBHOOK_SECRET`).

---

🎉 **Congratulations!** Aapki website ab YOUPI PG V2 payment gateway se jud chuki hai.
