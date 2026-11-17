/* Boko AI Recommendations — storefront widget
 * Renders recommendation cards with per-product add-to-cart and a bundle
 * add-to-cart. Pulls products from the app proxy; adds to cart via Shopify's
 * AJAX Cart API (/cart/add.js).
 */
(function () {
  var TAB_META = {
    purchased: { label: "Most purchased", badge: "Bestseller" },
    viewed: { label: "Most viewed", badge: "Trending" },
    upsell: { label: "Up-sells", badge: "Upgrade" },
    downsell: { label: "Down-sells", badge: "Great value" },
  };

  function money(cents) {
    // Shopify variant prices from proxy are in store currency units already.
    return (window.Shopify && Shopify.currency ? "" : "$") + Number(cents).toFixed(2);
  }

  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  function initWidget(root) {
    var cfg = {
      proxy: root.getAttribute("data-proxy") || "/apps/reco/recommend",
      type: root.getAttribute("data-type") || "upsell",
      perRow: parseInt(root.getAttribute("data-per-row") || "4", 10),
      limit: parseInt(root.getAttribute("data-limit") || "8", 10),
      bundleDiscount: parseFloat(root.getAttribute("data-bundle-discount") || "0"),
      showTabs: root.getAttribute("data-show-tabs") === "true",
      anchor: root.getAttribute("data-anchor") || "",
    };
    var grid = root.querySelector("[data-reco-grid]");
    var tabsEl = root.querySelector("[data-reco-tabs]");
    var bundle = [];

    function fetchReco(type) {
      var url =
        cfg.proxy +
        "?type=" + encodeURIComponent(type) +
        "&limit=" + cfg.limit +
        (cfg.anchor ? "&anchor=" + encodeURIComponent(cfg.anchor) : "");
      return fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) { return d.items || []; })
        .catch(function () { return []; });
    }

    function renderTabs(active) {
      if (!cfg.showTabs) { tabsEl.style.display = "none"; return; }
      tabsEl.innerHTML = "";
      Object.keys(TAB_META).forEach(function (k) {
        var b = el(
          '<button class="boko-reco__tab' + (k === active ? " is-on" : "") + '">' +
          '<span class="boko-reco__dot"></span>' + TAB_META[k].label + "</button>"
        );
        b.addEventListener("click", function () { load(k); });
        tabsEl.appendChild(b);
      });
    }

    function card(p, type) {
      var inB = bundle.indexOf(p.variantId) >= 0;
      var metric =
        type === "viewed" ? (p.views || 0).toLocaleString() + " views" :
        type === "purchased" ? (p.orders || 0).toLocaleString() + " sold" : "";
      var c = el(
        '<div class="boko-reco__card">' +
          '<div class="boko-reco__imgwrap">' +
            '<span class="boko-reco__badge">' + TAB_META[type].badge + "</span>" +
            '<label class="boko-reco__bsel"><input type="checkbox" ' + (inB ? "checked" : "") + "> Bundle</label>" +
            (p.img ? '<img loading="lazy" src="' + p.img + '" alt="' + String(p.title || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") + ' | Venom Emilio">' : "") +
          "</div>" +
          '<div class="boko-reco__cbody">' +
            '<div class="boko-reco__vendor">' + (p.vendor || "") + "</div>" +
            '<div class="boko-reco__ctitle">' + p.title + "</div>" +
            (metric ? '<div class="boko-reco__metric">' + metric + "</div>" : "") +
            '<div class="boko-reco__price">' + money(p.price) + "</div>" +
            '<button class="boko-reco__atc">Add to cart</button>' +
          "</div>" +
        "</div>"
      );
      c.querySelector(".boko-reco__atc").addEventListener("click", function () {
        addToCart(p.variantId, this);
      });
      c.querySelector('input[type="checkbox"]').addEventListener("change", function () {
        toggleBundle(p);
      });
      return c;
    }

    function load(type) {
      cfg.type = type;
      renderTabs(type);
      grid.style.gridTemplateColumns = "repeat(" + cfg.perRow + ",minmax(0,1fr))";
      grid.innerHTML = '<div class="boko-reco__loading">Loading recommendations…</div>';
      fetchReco(type).then(function (items) {
        grid.innerHTML = "";
        if (!items.length) { grid.innerHTML = '<div class="boko-reco__loading">No recommendations yet.</div>'; return; }
        items.forEach(function (p) { grid.appendChild(card(p, type)); });
      });
    }

    function variantNumber(gid) {
      // proxy returns gid like gid://shopify/ProductVariant/123 — cart needs the number
      var m = String(gid).match(/(\d+)$/);
      return m ? m[1] : gid;
    }

    function addToCart(variantId, btn) {
      fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: variantNumber(variantId), quantity: 1 }] }),
      })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function () {
          if (btn) { btn.textContent = "Added ✓"; btn.classList.add("is-added"); setTimeout(function () { btn.textContent = "Add to cart"; btn.classList.remove("is-added"); }, 1400); }
          document.dispatchEvent(new CustomEvent("boko:cart:added"));
        })
        .catch(function () { if (btn) btn.textContent = "Try again"; });
    }

    // ---- Bundle bar ----
    var bar;
    function ensureBar() {
      if (bar) return bar;
      bar = el(
        '<div class="boko-reco__bundlebar">' +
          '<div class="boko-reco__bthumbs" data-bt></div>' +
          '<div class="boko-reco__btext"><b data-bc>0 items</b><span data-bs></span></div>' +
          '<div class="boko-reco__bspacer"></div>' +
          '<div class="boko-reco__btotal"><small data-bcomp></small><span data-bt-total>$0.00</span></div>' +
          '<button class="boko-reco__bclear" data-bclear>Clear</button>' +
          '<button class="boko-reco__badd" data-badd>Add bundle to cart</button>' +
        "</div>"
      );
      document.body.appendChild(bar);
      bar.querySelector("[data-bclear]").addEventListener("click", function () { bundle = []; root._items = root._items || []; renderBundle(); load(cfg.type); });
      bar.querySelector("[data-badd]").addEventListener("click", addBundle);
      return bar;
    }
    var BUNDLE_ITEMS = {};
    function toggleBundle(p) {
      var i = bundle.indexOf(p.variantId);
      if (i >= 0) { bundle.splice(i, 1); delete BUNDLE_ITEMS[p.variantId]; }
      else { bundle.push(p.variantId); BUNDLE_ITEMS[p.variantId] = p; }
      renderBundle();
    }
    function renderBundle() {
      ensureBar();
      if (!bundle.length) { bar.classList.remove("is-show"); return; }
      var items = bundle.map(function (v) { return BUNDLE_ITEMS[v]; });
      var subtotal = items.reduce(function (s, p) { return s + Number(p.price); }, 0);
      var discount = (subtotal * cfg.bundleDiscount) / 100;
      bar.querySelector("[data-bt]").innerHTML = items.slice(0, 6).map(function (p) { return p.img ? '<img src="' + p.img + '" alt="' + String(p.title || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") + ' | Venom Emilio">' : ""; }).join("");
      bar.querySelector("[data-bc]").textContent = items.length + (items.length === 1 ? " item" : " items") + " in bundle";
      bar.querySelector("[data-bs]").innerHTML = cfg.bundleDiscount ? '<span class="boko-reco__save">Save ' + money(discount) + " (" + cfg.bundleDiscount + "%)</span>" : "";
      bar.querySelector("[data-bcomp]").textContent = cfg.bundleDiscount ? money(subtotal) : "";
      bar.querySelector("[data-bt-total]").textContent = money(subtotal - discount);
      bar.classList.add("is-show");
    }
    function addBundle() {
      var items = bundle.map(function (v) { return { id: variantNumber(v), quantity: 1 }; });
      fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items }),
      })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function () { document.dispatchEvent(new CustomEvent("boko:cart:added")); bundle = []; BUNDLE_ITEMS = {}; renderBundle(); load(cfg.type); });
    }

    renderTabs(cfg.type);
    load(cfg.type);
  }

  function boot() {
    document.querySelectorAll("[data-boko-reco]").forEach(initWidget);
  }
  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
