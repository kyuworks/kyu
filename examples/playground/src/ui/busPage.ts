const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 monospace; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; background: Canvas; color: CanvasText; }
  .box { border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); background: color-mix(in srgb, CanvasText 6%, Canvas); border-radius: 0.3rem; padding: 0.6rem 1rem; text-align: center; min-width: 8rem; }
  .box h2 { margin: 0 0 0.3rem; font-size: 0.9rem; }
  .count { font-size: 1.4rem; font-weight: bold; }
  .count-label { font-size: 0.75rem; opacity: 0.75; }
  .row { display: flex; justify-content: center; }
  .producer-row, .bus-row { margin: 0.5rem 0; }
  .arrow-down { text-align: center; font-size: 1.2rem; margin: 0.1rem 0; }
  .columns-row { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 1rem; margin-top: 0.5rem; }
  .column { display: flex; flex-direction: column; align-items: center; gap: 0.2rem; }
  .arrow-label { font-size: 0.75rem; opacity: 0.85; text-align: center; }
  .arrow-line { border-left: 1px solid color-mix(in srgb, CanvasText 40%, Canvas); height: 1.2rem; }
`

const SCRIPT = `
  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function buildColumn(subscription) {
    var column = el('div', 'column')
    column.appendChild(el('div', 'arrow-label', subscription.messageName))
    column.appendChild(el('div', 'arrow-line'))

    var box = el('div', 'box subscription-box')
    box.id = 'subscription-' + subscription.name
    box.appendChild(el('h2', null, subscription.name))
    box.appendChild(el('div', 'count processed', '–'))
    box.appendChild(el('div', 'count-label', 'processed'))
    if (subscription.waitingHandler) {
      box.appendChild(el('div', 'count in-progress', '–'))
      box.appendChild(el('div', 'count-label', 'in progress'))
    }
    column.appendChild(box)
    return column
  }

  function applyCounts(counts) {
    document.getElementById('producer-published').textContent = counts.producer.published
    document.getElementById('bus-published').textContent = counts.bus.published
    document.getElementById('bus-in-flight').textContent = counts.bus.inFlight
    counts.subscriptions.forEach(function (subscription) {
      var box = document.getElementById('subscription-' + subscription.name)
      if (!box) return
      var processed = box.querySelector('.processed')
      if (processed) processed.textContent = subscription.processed
      var inProgress = box.querySelector('.in-progress')
      if (inProgress && subscription.inProgress !== undefined) inProgress.textContent = subscription.inProgress
    })
  }

  var columnsBuilt = false

  async function refresh() {
    var response = await fetch('/bus.json')
    var json = await response.json()
    if (!columnsBuilt) {
      var container = document.getElementById('subscription-columns')
      json.topology.subscriptions.forEach(function (subscription) {
        container.appendChild(buildColumn(subscription))
      })
      columnsBuilt = true
    }
    applyCounts(json.counts)
  }

  document.addEventListener('DOMContentLoaded', function () {
    refresh().catch(function (error) {
      document.getElementById('diagram').textContent = 'failed to load /bus.json: ' + error.message
    })
    setInterval(function () {
      refresh().catch(function () {})
    }, 2000)
  })
`

/**
 * The bus diagram: producer on top, the bus in the middle, one column per
 * subscription below. Columns and counts come only from `/bus.json`, fetched
 * on load and every 2s, so the diagram cannot drift from what the worker
 * actually registers (src/subscriptions.ts).
 */
export function renderBusPage(dashboardUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Kinesin playground: bus</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Kinesin playground: the bus</h1>
<p><a href="/">Back to the forms</a> &middot;
<a href="${dashboardUrl}" target="_blank" rel="noreferrer">Hatchet dashboard</a></p>

<div id="diagram">
<div class="row producer-row">
<div class="box producer-box" id="producer-box">
<h2>Producer</h2>
<div class="count" id="producer-published">&ndash;</div>
<div class="count-label">published</div>
</div>
</div>
<div class="arrow-down">&darr;</div>
<div class="row bus-row">
<div class="box bus-box" id="bus-box">
<h2>Message bus</h2>
<div class="count" id="bus-published">&ndash;</div>
<div class="count-label">published</div>
<div class="count" id="bus-in-flight">&ndash;</div>
<div class="count-label">in flight</div>
</div>
</div>
<div class="row columns-row" id="subscription-columns"></div>
</div>

<script>${SCRIPT}</script>
</body>
</html>
`
}
