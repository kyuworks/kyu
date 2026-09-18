const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 monospace; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; background: Canvas; color: CanvasText; }
  form { display: grid; gap: 0.5rem; margin: 0.5rem 0; }
  label { display: grid; gap: 0.2rem; }
  pre { background: color-mix(in srgb, CanvasText 8%, Canvas); border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); padding: 0.5rem; min-height: 1.2rem; white-space: pre-wrap; }
`

const SCRIPT = `
  function field(form, name) { return form.elements.namedItem(name) }

  async function submitForm(form, result, path) {
    var body = {}
    for (var i = 0; i < form.elements.length; i++) {
      var input = form.elements[i]
      if (input.name && input.value) body[input.name] = input.value
    }
    var response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    var json = await response.json()
    result.textContent = JSON.stringify(json, null, 2)
    return { ok: response.ok, json: json }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var placeForm = document.getElementById('place-order-form')
    var shipForm = document.getElementById('ship-order-form')
    var placeResult = document.getElementById('place-order-result')
    var shipResult = document.getElementById('ship-order-result')

    // Listeners first: if the prefill below throws (e.g. randomUUID outside a
    // secure context), the forms still submit through fetch, not a plain GET.
    placeForm.addEventListener('submit', async function (event) {
      event.preventDefault()
      try {
        var outcome = await submitForm(placeForm, placeResult, placeForm.action)
        if (outcome.ok && outcome.json.orderId) {
          field(shipForm, 'tenantId').value = field(placeForm, 'tenantId').value
          field(shipForm, 'orderId').value = outcome.json.orderId
        }
      } catch (error) {
        placeResult.textContent = 'request failed: ' + error.message
      }
    })

    shipForm.addEventListener('submit', async function (event) {
      event.preventDefault()
      try {
        await submitForm(shipForm, shipResult, shipForm.action)
      } catch (error) {
        shipResult.textContent = 'request failed: ' + error.message
      }
    })

    // One id for both forms, so an order placed under it can be shipped
    // from the other form without retyping.
    var tenantId = crypto.randomUUID()
    field(placeForm, 'tenantId').value = tenantId
    field(shipForm, 'tenantId').value = tenantId
  })
`

/** The playground's one page: a place-order form, a ship-order form, and a dashboard link. */
export function renderUiPage(dashboardUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Qtaxis playground</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Qtaxis playground</h1>
<p>Sends messages onto the bus and shows the ids it got back. Watch what happens next in the
<a href="${dashboardUrl}" target="_blank" rel="noreferrer">Hatchet dashboard</a> or on the
<a href="/bus">bus diagram</a>.</p>

<section>
<h2>Place order</h2>
<form id="place-order-form" method="post" action="/orders">
<label>Tenant id <input name="tenantId" required /></label>
<label>Customer id (optional) <input name="customerId" /></label>
<button type="submit">Place order</button>
</form>
<pre id="place-order-result"></pre>
</section>

<section>
<h2>Ship order</h2>
<form id="ship-order-form" method="post" action="/shipments">
<label>Tenant id <input name="tenantId" required /></label>
<label>Order id <input name="orderId" required /></label>
<label>Carrier (optional) <input name="carrier" /></label>
<button type="submit">Ship order</button>
</form>
<pre id="ship-order-result"></pre>
</section>

<script>${SCRIPT}</script>
</body>
</html>
`
}
