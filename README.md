# FaaST Picktask Helper
Faast Picktask Helper script
> Browser extension (Tampermonkey userscript) that automates bin lookups and pick task decisions on the FaaST Create Pick Task page.

**Author:** David Thunig ([davthun@amazon.com](mailto:davthun@amazon.com))  
**Platform:** Tampermonkey (Chrome, Edge, Firefox)  
**Target page:** [faast.amazon.co.uk/web/picktasks/new](https://faast.amazon.co.uk/web/picktasks/new)

* * *

## What it does

FaaST PickTask Helper loads your open orders and live bin inventory with two clicks, then classifies each ASIN into one of three pick approaches:

<table style="min-width: 100px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Result</p></th><th colspan="1" rowspan="1"><p>Meaning</p></th><th colspan="1" rowspan="1"><p>Condition</p></th><th colspan="1" rowspan="1"><p>Action</p></th></tr><tr><td colspan="1" rowspan="1"><p><strong>Bulk</strong></p></td><td colspan="1" rowspan="1"><p>Single bin covers full order qty</p></td><td colspan="1" rowspan="1"><p>avail ≥ qty &amp; avail % qty = 0</p></td><td colspan="1" rowspan="1"><p>Click row → form filled</p></td></tr><tr><td colspan="1" rowspan="1"><p><strong>Bulk Split</strong></p></td><td colspan="1" rowspan="1"><p>No single bin, but stock exists</p></td><td colspan="1" rowspan="1"><p>avail &gt; 0 &amp; not divisible</p></td><td colspan="1" rowspan="1"><p>Proposal across bins</p></td></tr><tr><td colspan="1" rowspan="1"><p><strong>Proposal</strong></p></td><td colspan="1" rowspan="1"><p>High stock, low qty, or heavy item (&gt;30 kg)</p></td><td colspan="1" rowspan="1"><p>avail &gt; 60 or qty &lt; 2 or weight &gt; 30 kg</p></td><td colspan="1" rowspan="1"><p>Weight-based proposal</p></td></tr></tbody></table>

One more click fills the FaaST form automatically with ASIN and batch size.

The script is **read-only and informational** — it never modifies inventory, changes orders, or replaces any existing FaaST workflow.

* * *

## Why use it

Today, identifying whether an ASIN can be bulk-picked requires manually checking bin stock in FaaST, comparing it against the open order quantity, and doing the pick task math yourself. For 10 ASINs, that's 10 manual lookups — every session, every day.

FaaST PickTask Helper automates those lookups. Orders and inventory load in seconds. Results appear inline. You click the row and the form is filled. The decision is made for you.

**Benefits:**

1.  See all open ASINs with order quantities loaded automatically — no manual entry
    
2.  Know instantly whether a Bulk pick is possible for each ASIN
    
3.  Get a ready-made pick task proposal when no single bin covers the full order
    
4.  Less manual lookup, faster task creation, fewer errors
    

* * *

## Who should use this

-   **Process Assistants (PAs)** creating pick tasks in FaaST daily
    
-   **Vendor Site Leads** overseeing pick task creation and order fulfilment
    
-   **Control Tower Specialists** managing workload distribution across the network
    
-   **Anyone** who creates pick tasks and wants instant bulk pick visibility
    

* * *

## How to use

1.  Open [faast.amazon.co.uk/web/picktasks/new](https://faast.amazon.co.uk/web/picktasks/new)
    
2.  Click **⬇ Orders** — top 10 open ASINs load with order counts and unit quantities
    
3.  Click **🗄 Inventory** — bin stock and weights fetched; Bulk / Bulk Split / Proposal calculated per ASIN
    
4.  Click any result row — FaaST form fills automatically with ASIN and batch size
    

### Additional controls

<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Button</p></th><th colspan="1" rowspan="1"><p>Function</p></th></tr><tr><td colspan="1" rowspan="1"><p>🔄 Reload</p></td><td colspan="1" rowspan="1"><p>Refreshes data from cache</p></td></tr><tr><td colspan="1" rowspan="1"><p>🗑 Clear Cache</p></td><td colspan="1" rowspan="1"><p>Wipes inventory, tasks, and weight data</p></td></tr><tr><td colspan="1" rowspan="1"><p>⚖ Weight Check</p></td><td colspan="1" rowspan="1"><p>Toggle 30 kg weight limit on/off</p></td></tr></tbody></table>

> **Stale data warning:** Inventory data older than 30 minutes triggers a red warning indicator.

> **Weight check:** When disabled, heavy items (>30 kg) are no longer automatically routed to Proposal — the standard Bulk / Bulk Split logic applies instead. Use this when you have confirmed the station can handle the weight.

* * *

## Installation

1.  Install **Tampermonkey** for your browser: [tampermonkey.net](https://www.tampermonkey.net) (Chrome, Edge, Firefox)
    
2.  Download **Faast – Picktask Helper-1.6.user.js** from [Amazon Drive → FaaST PickTask Helper](https://drive.corp.amazon.com/documents/davthun@/FaaST%20PickTask%20Helper/Faast%20%E2%80%93%20Picktask%20Helper-1.6.user.js)
    
3.  Open the `.user.js` file in your browser — Tampermonkey shows an install prompt
    
4.  Click **Install** — the script activates immediately and auto-updates going forward
    

* * *

## Support & Contributing

-   Questions, feedback, or bug reports → [davthun@amazon.com](mailto:davthun@amazon.com)
    
-   Feature requests and contributions → [GitHub](https://github.com/DavThunAMZ/FaaST-Picktask-Helper)
    

* * *

*AMAZON CONFIDENTIAL — For internal use only — FaaST PickTask Helper
