// pay-gate njs handler for nginx sidecar mode
//
// Replaces auth_request with full control over 402 responses.
// nginx's auth_request module cannot forward 402 status codes or
// custom headers — it only recognizes 2xx (allow) and 401/403 (deny).
// njs subrequests give us access to the full response.

// x402 headers that must pass between client and pay-gate
var X402_HEADERS = [
    'payment-required',
    'payment-response',
    'content-type'
];

// Headers pay-gate sets on verified requests (forwarded to origin)
var PAY_HEADERS = [
    'x-pay-verified',
    'x-pay-from',
    'x-pay-amount',
    'x-pay-settlement'
];

async function handle(r) {
    // Step 1: Ask pay-gate if this request is paid
    var check = await r.subrequest('/__pay_check', {
        method: 'POST'
    });

    // Step 2: If 402, forward the full response to the client
    if (check.status === 402) {
        for (var i = 0; i < X402_HEADERS.length; i++) {
            var h = X402_HEADERS[i];
            if (check.headersOut[h]) {
                r.headersOut[h] = check.headersOut[h];
            }
        }
        r.return(402, check.responseText);
        return;
    }

    // Step 3: Non-2xx from pay-gate (403 blocked, 429 rate limited, 503 facilitator down)
    if (check.status < 200 || check.status >= 300) {
        if (check.headersOut['content-type']) {
            r.headersOut['Content-Type'] = check.headersOut['content-type'];
        }
        r.return(check.status, check.responseText);
        return;
    }

    // Step 4: 2xx — request is authorized, proxy to origin
    // Subrequest the original URI (not /__origin) so the origin sees the real path.
    // The /__origin_proxy location uses regex to strip the prefix and proxy correctly.
    var origin = await r.subrequest('/__origin_proxy' + r.uri, {
        method: r.method,
        args: r.variables.args,
        body: r.requestBody || ''
    });

    // Forward origin response headers
    for (var key in origin.headersOut) {
        r.headersOut[key] = origin.headersOut[key];
    }

    // Add PAYMENT-RESPONSE header from pay-gate check if present
    if (check.headersOut['payment-response']) {
        r.headersOut['PAYMENT-RESPONSE'] = check.headersOut['payment-response'];
    }

    r.return(origin.status, origin.responseText);
}

export default { handle };
