/* ==================================================================
   Loan Ledger — app logic
   Firestore collections:
     "loans" — { product, amount, dueDate, description, app,
                 months, installmentIndex, groupId, createdAt }
     "apps"  — { name, createdAt }   ← saved app names, persist forever
   dueDate is stored as a plain "YYYY-MM-DD" string so there are no
   timezone surprises when we build and compare the calendar.
================================================================== */

/* ------------------------------------------------------------------
   1. FIREBASE CONFIG
------------------------------------------------------------------ */
const firebaseConfig = {
  apiKey: "AIzaSyCWdTMCOwUk9N2qn2_Ri7khdaNkUX_Hcy4",
  authDomain: "loan-ledger-a53fb.firebaseapp.com",
  projectId: "loan-ledger-a53fb",
  storageBucket: "loan-ledger-a53fb.firebasestorage.app",
  messagingSenderId: "217402510647",
  appId: "1:217402510647:web:8017521e4765d081689eb2",
  measurementId: "G-HEY089D3E6"
};

const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");

let db = null;
if (isConfigured) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
} else {
  document.getElementById("config-banner").hidden = false;
}

/* ------------------------------------------------------------------
   2. STATE + HELPERS
------------------------------------------------------------------ */
let loans = [];                 // all loans from Firestore
let savedApps = [];             // names from the "apps" collection
let viewYear, viewMonth;        // currently displayed month (0-based month)
let modalCtx = null;            // { type: 'date'|'week'|'app', key } while modal open
let editingId = null;           // loan id currently in inline-edit mode

const pesos = new Intl.NumberFormat("en-PH", {
  style: "currency", currency: "PHP", maximumFractionDigits: 0
});
const pesosExact = new Intl.NumberFormat("en-PH", {
  style: "currency", currency: "PHP", minimumFractionDigits: 2
});
function trim1(x) { return (Math.round(x * 10) / 10).toString(); }
function pesosCompactFmt(n) {
  const abs = Math.abs(n || 0);
  if (abs < 1000)  return "₱" + Math.round(n || 0).toLocaleString("en-PH");
  if (abs < 1e6)   return "₱" + trim1(n / 1000) + "K";
  return "₱" + trim1(n / 1e6) + "M";
}

function todayStr() {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
}
function ymd(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function daysBetween(a, b) {
  const da = new Date(a + "T00:00:00");
  const db_ = new Date(b + "T00:00:00");
  return Math.round((db_ - da) / 86400000);
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
}
/* add n calendar months, clamping the day so Jan 31 + 1 → Feb 28/29 */
function addMonthsClamp(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(y, m - 1 + n, 1);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  return ymd(base.getFullYear(), base.getMonth(), Math.min(d, lastDay));
}
function payWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const offset = (d.getDay() - 2 + 7) % 7;   // days since Tuesday
  return addDays(dateStr, -offset);
}
function fmtShort(dateStr) {
  return new Date(dateStr + "T00:00:00")
    .toLocaleDateString("en-PH", { month: "short", day: "numeric" });
}
function fmtLong(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-PH",
    { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
const byDue = (a, b) => (a.dueDate || "").localeCompare(b.dueDate || "");

/* every app name we know: saved apps ∪ apps used on loans */
function knownApps() {
  const set = new Map(); // lowercase -> display name (first seen wins)
  for (const a of savedApps) if (a) set.set(a.toLowerCase(), a);
  for (const l of loans) if (l.app) {
    const k = l.app.toLowerCase();
    if (!set.has(k)) set.set(k, l.app);
  }
  return [...set.values()].sort((x, y) => x.localeCompare(y));
}

/* persist an app name the first time it's used */
async function saveAppIfNew(name) {
  const n = (name || "").trim();
  if (!n || !db) return;
  const exists = savedApps.some(a => a.toLowerCase() === n.toLowerCase());
  if (exists) return;
  try {
    await db.collection("apps").add({
      name: n,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Couldn't save app name:", err);
  }
}

/* ------------------------------------------------------------------
   3. ELEMENTS
------------------------------------------------------------------ */
const els = {
  form: document.getElementById("loan-form"),
  submit: document.getElementById("submit-btn"),
  appInput: document.getElementById("app"),
  appToggle: document.getElementById("app-toggle"),
  appOptions: document.getElementById("app-options"),
  appList: document.getElementById("app-list"),
  months: document.getElementById("months"),
  termsHint: document.getElementById("terms-hint"),
  calDays: document.getElementById("calendar-days"),
  calTitle: document.getElementById("cal-title"),
  tooltip: document.getElementById("tooltip"),
  modal: document.getElementById("modal"),
  modalEyebrow: document.getElementById("modal-eyebrow"),
  modalDate: document.getElementById("modal-date"),
  modalTotal: document.getElementById("modal-total"),
  detailList: document.getElementById("detail-list"),
  statTotal: document.getElementById("stat-total"),
  statCount: document.getElementById("stat-count"),
  statNext: document.getElementById("stat-next"),
  payWeeks: document.getElementById("pay-weeks"),
  byApp: document.getElementById("by-app"),
  appGrand: document.getElementById("app-grand"),
};

/* ------------------------------------------------------------------
   4. LIVE LISTENERS
------------------------------------------------------------------ */
function startListening() {
  if (!db) { render(); return; }

  db.collection("loans").onSnapshot(snap => {
    loans = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    render();
  }, err => {
    console.error("Firestore error:", err);
    alert("Couldn't reach Firestore. Check your config and security rules.");
  });

  db.collection("apps").onSnapshot(snap => {
    savedApps = snap.docs.map(doc => (doc.data().name || "")).filter(Boolean);
    renderAppSuggestions();
    if (!els.appOptions.hidden) renderComboOptions(); // refresh open dropdown
  }, err => console.error("Apps listener error:", err));
}

/* ------------------------------------------------------------------
   5. APP COMBO (dropdown that remembers every app you've saved)
------------------------------------------------------------------ */
function renderComboOptions() {
  const q = els.appInput.value.trim().toLowerCase();
  const all = knownApps();
  const filtered = q ? all.filter(a => a.toLowerCase().includes(q)) : all;
  const exact = all.some(a => a.toLowerCase() === q);

  let html = filtered.map(a =>
    `<div class="combo__opt" role="option" data-value="${escapeHtml(a)}">${escapeHtml(a)}</div>`
  ).join("");

  if (q && !exact) {
    html += `<div class="combo__opt combo__opt--new" role="option" data-value="${escapeHtml(els.appInput.value.trim())}">
               + Add “${escapeHtml(els.appInput.value.trim())}”
             </div>`;
  }
  if (!html) {
    html = `<div class="combo__empty">No apps saved yet — type a name to add one.</div>`;
  }
  els.appOptions.innerHTML = html;
}

function openCombo() {
  renderComboOptions();
  els.appOptions.hidden = false;
  els.appInput.setAttribute("aria-expanded", "true");
}
function closeCombo() {
  els.appOptions.hidden = true;
  els.appInput.setAttribute("aria-expanded", "false");
}

els.appInput.addEventListener("focus", openCombo);
els.appInput.addEventListener("input", openCombo);
els.appInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCombo();
});
els.appToggle.addEventListener("click", () => {
  if (els.appOptions.hidden) { els.appInput.focus(); openCombo(); }
  else closeCombo();
});
/* mousedown fires before the input loses focus, so selection wins */
els.appOptions.addEventListener("mousedown", (e) => {
  const opt = e.target.closest(".combo__opt");
  if (!opt) return;
  e.preventDefault();
  els.appInput.value = opt.dataset.value;
  closeCombo();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#app-combo")) closeCombo();
});

/* datalist for the modal's edit fields */
function renderAppSuggestions() {
  els.appList.innerHTML = knownApps()
    .map(a => `<option value="${escapeHtml(a)}">`).join("");
}

/* installment hint visibility */
els.months.addEventListener("change", () => {
  els.termsHint.hidden = parseInt(els.months.value, 10) <= 1;
});

/* ------------------------------------------------------------------
   6. ADD A LOAN (1 doc per month for installment plans)
------------------------------------------------------------------ */
els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const product = els.form.product.value.trim();
  const amount = parseFloat(els.form.amount.value);
  const dueDate = els.form.due.value;              // "YYYY-MM-DD"
  const description = els.form.description.value.trim();
  const app = els.appInput.value.trim();
  const months = Math.min(12, Math.max(1, parseInt(els.months.value, 10) || 1));

  if (!product || isNaN(amount) || !dueDate || !app) return;

  if (!db) {
    alert("Connect Firebase first (see the banner at the top) to save loans.");
    return;
  }

  els.submit.disabled = true;
  els.submit.textContent = "Saving…";
  try {
    const groupId = months > 1
      ? (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))
      : null;

    const batch = db.batch();
    for (let i = 0; i < months; i++) {
      const ref = db.collection("loans").doc();
      batch.set(ref, {
        product: months > 1 ? `${product} (${i + 1}/${months})` : product,
        amount,
        dueDate: addMonthsClamp(dueDate, i),
        description,
        app,
        months,
        installmentIndex: i + 1,
        groupId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    await saveAppIfNew(app);

    els.form.reset();
    els.form.due.value = todayStr();
    els.termsHint.hidden = true;
    els.form.product.focus();
  } catch (err) {
    console.error(err);
    alert("Couldn't save that loan. Please try again.");
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = "Add loan";
  }
});

/* ------------------------------------------------------------------
   7. DELETE / EDIT A LOAN
------------------------------------------------------------------ */
async function deleteLoan(id) {
  if (!db || !id) return;
  if (!confirm("Remove this loan from the ledger?")) return;
  try {
    await db.collection("loans").doc(id).delete();
    // modal stays open; the snapshot re-render refreshes (or closes) it
  } catch (err) {
    console.error(err);
    alert("Couldn't remove that loan.");
  }
}

async function saveLoanEdit(id, li) {
  const amount = parseFloat(li.querySelector(".edit-amount").value);
  const app = li.querySelector(".edit-app").value.trim();
  const description = li.querySelector(".edit-desc").value.trim();
  if (isNaN(amount) || amount < 0 || !app) {
    alert("Please enter a valid amount and app.");
    return;
  }
  try {
    await db.collection("loans").doc(id).update({ amount, app, description });
    await saveAppIfNew(app);
    editingId = null;
    // snapshot re-render refreshes the open modal
  } catch (err) {
    console.error(err);
    alert("Couldn't save those changes.");
  }
}

/* ------------------------------------------------------------------
   8. RENDER EVERYTHING
------------------------------------------------------------------ */
function render() {
  renderAppSuggestions();
  renderSummary();
  renderCalendar();
  renderPayWeeks();
  renderByApp();
  if (!els.modal.hidden && modalCtx) renderModal(); // keep open modal fresh
}

function renderSummary() {
  const total = loans.reduce((s, l) => s + (l.amount || 0), 0);
  els.statTotal.textContent = pesos.format(total);
  els.statCount.textContent = loans.length;

  const today = todayStr();
  const upcoming = loans
    .filter(l => l.dueDate >= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  els.statNext.textContent = upcoming.length ? fmtShort(upcoming[0].dueDate) : "—";
}

function groupByDate() {
  const map = {};
  for (const l of loans) {
    if (!l.dueDate) continue;
    (map[l.dueDate] ??= { total: 0, items: [] });
    map[l.dueDate].total += (l.amount || 0);
    map[l.dueDate].items.push(l);
  }
  return map;
}

function urgencyClass(dateStr) {
  const diff = daysBetween(todayStr(), dateStr);
  if (diff < 0) return "day--overdue";
  if (diff <= 7) return "day--soon";
  return "day--later";
}

function renderCalendar() {
  const grouped = groupByDate();
  const monthNames = ["January","February","March","April","May","June",
    "July","August","September","October","November","December"];
  els.calTitle.textContent = `${monthNames[viewMonth]} ${viewYear}`;

  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const startOffset = (firstWeekday - 2 + 7) % 7;                 // days since Tuesday
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today = todayStr();

  let html = "";
  for (let i = 0; i < startOffset; i++) html += `<div class="day day--empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = ymd(viewYear, viewMonth, d);
    const info = grouped[dateStr];
    const isToday = dateStr === today;

    const classes = ["day"];
    if (isToday) classes.push("day--today");
    if (info) classes.push("day--has", urgencyClass(dateStr));

    if (info) {
      html += `
        <div class="${classes.join(" ")}" tabindex="0" role="button"
             data-date="${dateStr}"
             aria-label="${escapeHtml(dateStr)}, ${info.items.length} due, total ${pesos.format(info.total)}">
          <span class="day__num">${d}</span>
          <span class="day__amount">${pesosCompactFmt(info.total)}</span>
          <span class="day__count">${info.items.length} item${info.items.length > 1 ? "s" : ""}</span>
        </div>`;
    } else {
      html += `<div class="${classes.join(" ")}"><span class="day__num">${d}</span></div>`;
    }
  }
  els.calDays.innerHTML = html;
}

/* ---------- pay weeks (clickable) ---------- */
function renderPayWeeks() {
  const map = {};
  for (const l of loans) {
    if (!l.dueDate) continue;
    const ws = payWeekStart(l.dueDate);
    (map[ws] ??= { total: 0, count: 0 });
    map[ws].total += (l.amount || 0);
    map[ws].count++;
  }

  const weeks = Object.keys(map).sort();
  if (!weeks.length) {
    els.payWeeks.innerHTML = `<p class="empty-note">No loans yet.</p>`;
    return;
  }

  const thisWeek = payWeekStart(todayStr());
  const today = todayStr();

  els.payWeeks.innerHTML = weeks.map(ws => {
    const we = addDays(ws, 6);
    const { total, count } = map[ws];
    const isThis = ws === thisWeek;
    const isPast = we < today;
    const cls = isThis ? "payweek--current" : isPast ? "payweek--past" : "";
    const tag = isThis ? `<span class="payweek__tag">This week</span>` : "";
    return `
      <li class="payweek ${cls}" data-ws="${ws}" tabindex="0" role="button"
          aria-label="Pay week ${fmtShort(ws)} to ${fmtShort(we)}, ${count} loans, total ${pesos.format(total)}">
        <div>
          <div class="payweek__range">${fmtShort(ws)} – ${fmtShort(we)} ${tag}</div>
          <div class="payweek__meta">${count} loan${count > 1 ? "s" : ""} · tap for details</div>
        </div>
        <div class="payweek__total">${pesos.format(total)}</div>
      </li>`;
  }).join("");
}

/* ---------- by app (clickable) ---------- */
function renderByApp() {
  const map = {};
  for (const l of loans) {
    const a = l.app || "—";
    (map[a] ??= { total: 0, count: 0 });
    map[a].total += (l.amount || 0);
    map[a].count++;
  }

  const apps = Object.keys(map).sort((x, y) => map[y].total - map[x].total);
  const grand = apps.reduce((s, a) => s + map[a].total, 0);
  els.appGrand.textContent = `${pesos.format(grand)} total`;

  if (!apps.length) {
    els.byApp.innerHTML = `<p class="empty-note">No loans yet.</p>`;
    return;
  }

  els.byApp.innerHTML = apps.map(a => {
    const { total, count } = map[a];
    const pct = grand ? Math.round((total / grand) * 100) : 0;
    return `
      <li class="appstat" data-app="${escapeHtml(a)}" tabindex="0" role="button"
          aria-label="${escapeHtml(a)}, ${count} loans, total ${pesos.format(total)}">
        <div class="appstat__head">
          <span class="appstat__name">${escapeHtml(a)}</span>
          <span class="appstat__total">${pesos.format(total)}</span>
        </div>
        <div class="appstat__bar"><span style="width:${pct}%"></span></div>
        <div class="appstat__meta">${count} loan${count > 1 ? "s" : ""} · ${pct}% of total · tap for details</div>
      </li>`;
  }).join("");
}

/* ------------------------------------------------------------------
   9. CALENDAR NAVIGATION
------------------------------------------------------------------ */
document.getElementById("prev-month").addEventListener("click", () => {
  viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } renderCalendar();
});
document.getElementById("next-month").addEventListener("click", () => {
  viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } renderCalendar();
});
document.getElementById("today-btn").addEventListener("click", () => {
  const d = new Date(); viewYear = d.getFullYear(); viewMonth = d.getMonth(); renderCalendar();
});

/* ------------------------------------------------------------------
   10. HOVER TOOLTIP
------------------------------------------------------------------ */
els.calDays.addEventListener("mouseover", (e) => {
  const cell = e.target.closest(".day--has");
  if (!cell) return;
  const info = groupByDate()[cell.dataset.date];
  if (!info) return;

  const rows = info.items.map(i =>
    `<li><span>${escapeHtml(i.product)}</span><span>${pesos.format(i.amount || 0)}</span></li>`
  ).join("");
  els.tooltip.innerHTML = `<div class="tooltip__title">Products due</div><ul>${rows}</ul>`;
  els.tooltip.hidden = false;
});
els.calDays.addEventListener("mousemove", (e) => {
  if (els.tooltip.hidden) return;
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = els.tooltip.getBoundingClientRect();
  if (x + r.width > window.innerWidth)  x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
  els.tooltip.style.left = x + "px";
  els.tooltip.style.top = y + "px";
});
els.calDays.addEventListener("mouseout", (e) => {
  if (!e.relatedTarget || !e.relatedTarget.closest?.(".day--has")) els.tooltip.hidden = true;
});

/* ------------------------------------------------------------------
   11. DETAIL MODAL — day / pay week / app share one panel
------------------------------------------------------------------ */
function ctxData(ctx) {
  if (!ctx) return null;

  if (ctx.type === "date") {
    const info = groupByDate()[ctx.key];
    if (!info) return null;
    return {
      eyebrow: "Due on",
      title: fmtLong(ctx.key),
      items: info.items.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0)),
      showDue: false,
    };
  }
  if (ctx.type === "week") {
    const we = addDays(ctx.key, 6);
    const items = loans.filter(l => l.dueDate >= ctx.key && l.dueDate <= we).sort(byDue);
    if (!items.length) return null;
    return {
      eyebrow: "Pay week",
      title: `${fmtShort(ctx.key)} – ${fmtShort(we)}`,
      items,
      showDue: true,
    };
  }
  if (ctx.type === "app") {
    const items = loans.filter(l => (l.app || "—") === ctx.key).sort(byDue);
    if (!items.length) return null;
    return {
      eyebrow: "App",
      title: ctx.key,
      items,
      showDue: true,
    };
  }
  return null;
}

function detailItemHtml(item, showDue) {
  const dueBadge = showDue && item.dueDate
    ? `<span class="app-badge app-badge--date">Due ${fmtShort(item.dueDate)}</span>` : "";

  if (editingId === item.id) {
    return `
      <li class="detail-item detail-item--editing" data-id="${item.id}">
        <div class="detail-item__top">
          <span class="detail-item__product">${escapeHtml(item.product)}</span>
          ${dueBadge}
        </div>
        <div class="edit-grid">
          <label class="edit-label">Amount
            <div class="amount-input">
              <span class="amount-input__symbol">₱</span>
              <input type="number" class="edit-amount" min="0" step="0.01"
                     value="${Number(item.amount || 0)}" />
            </div>
          </label>
          <label class="edit-label">App
            <input type="text" class="edit-app" list="app-list"
                   value="${escapeHtml(item.app || "")}" />
          </label>
          <label class="edit-label edit-label--wide">Description
            <textarea class="edit-desc" rows="2">${escapeHtml(item.description || "")}</textarea>
          </label>
        </div>
        <div class="detail-item__actions">
          <button class="btn btn--primary btn--small" data-save="${item.id}">Save</button>
          <button class="btn btn--ghost btn--small" data-cancel>Cancel</button>
        </div>
      </li>`;
  }

  return `
    <li class="detail-item" data-id="${item.id}">
      <div class="detail-item__top">
        <span class="detail-item__product">${escapeHtml(item.product)}</span>
        <span class="detail-item__amount">${pesosExact.format(item.amount || 0)}</span>
      </div>
      <div class="detail-item__meta">
        <span class="app-badge">${escapeHtml(item.app || "—")}</span>
        ${dueBadge}
      </div>
      ${item.description ? `<p class="detail-item__desc">${escapeHtml(item.description)}</p>` : ""}
      <div class="detail-item__actions">
        <button class="btn btn--ghost btn--small" data-edit="${item.id}">Edit</button>
        <button class="btn btn--danger btn--small" data-delete="${item.id}">Remove</button>
      </div>
    </li>`;
}

function renderModal() {
  const d = ctxData(modalCtx);
  if (!d) { closeModal(); return; }

  const total = d.items.reduce((s, l) => s + (l.amount || 0), 0);
  els.modalEyebrow.textContent = d.eyebrow;
  els.modalDate.textContent = d.title;
  els.modalTotal.textContent = pesosExact.format(total);
  els.detailList.innerHTML = d.items.map(i => detailItemHtml(i, d.showDue)).join("");
}

function openModalCtx(ctx) {
  modalCtx = ctx;
  editingId = null;
  const d = ctxData(ctx);
  if (!d) return;
  els.tooltip.hidden = true;
  renderModal();
  els.modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  els.modal.hidden = true;
  modalCtx = null;
  editingId = null;
  document.body.style.overflow = "";
}

/* open from calendar */
els.calDays.addEventListener("click", (e) => {
  const cell = e.target.closest(".day--has");
  if (cell) openModalCtx({ type: "date", key: cell.dataset.date });
});
els.calDays.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const cell = e.target.closest(".day--has");
    if (cell) { e.preventDefault(); openModalCtx({ type: "date", key: cell.dataset.date }); }
  }
});

/* open from pay weeks */
els.payWeeks.addEventListener("click", (e) => {
  const row = e.target.closest(".payweek");
  if (row) openModalCtx({ type: "week", key: row.dataset.ws });
});
els.payWeeks.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const row = e.target.closest(".payweek");
    if (row) { e.preventDefault(); openModalCtx({ type: "week", key: row.dataset.ws }); }
  }
});

/* open from apps */
els.byApp.addEventListener("click", (e) => {
  const row = e.target.closest(".appstat");
  if (row) openModalCtx({ type: "app", key: row.dataset.app });
});
els.byApp.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const row = e.target.closest(".appstat");
    if (row) { e.preventDefault(); openModalCtx({ type: "app", key: row.dataset.app }); }
  }
});

/* modal actions: close / edit / save / cancel / delete */
els.modal.addEventListener("click", (e) => {
  if (e.target.dataset.close !== undefined) { closeModal(); return; }

  const editId = e.target.dataset.edit;
  if (editId) { editingId = editId; renderModal(); return; }

  if (e.target.dataset.cancel !== undefined) { editingId = null; renderModal(); return; }

  const saveId = e.target.dataset.save;
  if (saveId) { saveLoanEdit(saveId, e.target.closest(".detail-item")); return; }

  const del = e.target.dataset.delete;
  if (del) deleteLoan(del);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.modal.hidden) closeModal();
});

/* ------------------------------------------------------------------
   12. BOOT
------------------------------------------------------------------ */
(function init() {
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  els.form.due.value = todayStr();
  startListening();
})();