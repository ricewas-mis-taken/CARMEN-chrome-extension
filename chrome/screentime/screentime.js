// Domain-to-category map, loaded from the bundled screentime-domains.json
// (kept in sync with carmen-desktop's screentime_domains.json -- see that
// file's own "_comment" for where it comes from: a small hand-curated set
// plus ~45k domains imported from the UT1 blacklists, CC BY-SA). Too large
// (44k+ entries) to inline as a JS literal here, so it's fetched once at
// page load instead of embedded directly.
//
// Storage (chrome.storage.local's SCREEN_TIME_DAY_KEY bucket, see
// background.js) only ever holds the raw domain -> seconds tally -- no
// category is baked in at write time. That means categorization is entirely
// retroactive: every render() call re-runs categorizeDomain() against
// whatever DOMAIN_CATEGORIES currently holds, so time logged before this
// domain list existed (or before it knew about a given site) gets
// categorized correctly the moment the list catches up, with no migration
// needed. The only way that *doesn't* happen is if this fetch itself fails
// silently -- previously it just logged a console.warn and fell through
// with DOMAIN_CATEGORIES == {}, which categorizes literally everything as
// "Other" with no visible sign anything went wrong. loadDomainCategories()
// now reports success/failure so the caller can surface that instead of
// hiding it.
let DOMAIN_CATEGORIES = {};

async function loadDomainCategories() {
  try {
    const resp = await fetch(chrome.runtime.getURL("screentime-domains.json"));
    const data = await resp.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("screentime-domains.json did not parse to an object");
    }
    DOMAIN_CATEGORIES = data;
    return true;
  } catch (err) {
    console.warn("CARMEN: could not load domain categories.", err);
    DOMAIN_CATEGORIES = {};
    return false;
  }
}

const CATEGORIES = ["Entertainment", "Education", "Games", "Tools", "Other"];
const CATEGORY_COLORS = {
  Entertainment: "#E27D60", Education: "#4A90D9", Games: "#8E44AD", Tools: "#2E8B57", Other: "#9AA0A8",
};
const GROUP_THRESHOLD_SECONDS = 5 * 60;

function categorizeDomain(domain) {
  const key = (domain || "").toLowerCase().replace(/^www\./, "");
  if (DOMAIN_CATEGORIES[key]) return DOMAIN_CATEGORIES[key];
  const parts = key.split(".");
  if (parts.length > 2) {
    const parent = parts.slice(-2).join(".");
    if (DOMAIN_CATEGORIES[parent]) return DOMAIN_CATEGORIES[parent];
  }
  return "Other";
}

function formatDuration(seconds) {
  seconds = Math.round(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function weekDayKeys(date) {
  const monday = new Date(date);
  const dow = (date.getDay() + 6) % 7; // Monday = 0
  monday.setDate(date.getDate() - dow);
  const keys = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    keys.push(dayKey(d));
  }
  return keys;
}

function aggregate(byDay, keys) {
  const totals = {};
  for (const key of keys) {
    const bucket = byDay[key];
    if (!bucket) continue;
    for (const [domain, seconds] of Object.entries(bucket)) {
      totals[domain] = (totals[domain] || 0) + seconds;
    }
  }
  return totals;
}

function renderChart(byCategory) {
  const chart = document.getElementById("chart");
  chart.innerHTML = "";
  const entries = CATEGORIES.map((cat) => [cat, (byCategory[cat] || []).reduce((s, [, secs]) => s + secs, 0)])
    .filter(([, total]) => total > 0);

  if (!entries.length) {
    chart.innerHTML = '<div class="empty-state">No screen time recorded yet.</div>';
    return;
  }

  const max = Math.max(...entries.map(([, total]) => total));
  for (const [category, total] of entries) {
    const row = document.createElement("div");
    row.className = "chart-row";
    row.innerHTML = `
      <div class="chart-label">${category}</div>
      <div class="chart-track">
        <div class="chart-fill" style="width:${Math.max(2, (total / max) * 100)}%; background:${CATEGORY_COLORS[category]}"></div>
      </div>
      <div class="chart-value">${formatDuration(total)}</div>
    `;
    chart.appendChild(row);
  }
}

function renderSections(byCategory) {
  const container = document.getElementById("sections");
  container.innerHTML = "";

  let any = false;
  for (const category of CATEGORIES) {
    const entries = (byCategory[category] || []).slice().sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    any = true;

    const total = entries.reduce((s, [, secs]) => s + secs, 0);
    const section = document.createElement("div");
    section.className = "category-section";

    const header = document.createElement("div");
    header.className = "category-header";
    header.style.color = CATEGORY_COLORS[category];
    header.textContent = `${category} • ${formatDuration(total)}`;
    section.appendChild(header);

    const shown = entries.filter(([, secs]) => secs >= GROUP_THRESHOLD_SECONDS);
    const grouped = entries.filter(([, secs]) => secs < GROUP_THRESHOLD_SECONDS);

    for (const [domain, secs] of shown) {
      section.appendChild(domainRow(domain, secs));
    }

    if (grouped.length) {
      const groupedTotal = grouped.reduce((s, [, secs]) => s + secs, 0);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "group-toggle";
      toggle.textContent = `+ ${grouped.length} more under 5 min (${formatDuration(groupedTotal)} total)`;
      section.appendChild(toggle);

      const details = document.createElement("div");
      details.className = "group-details hidden";
      for (const [domain, secs] of grouped) {
        details.appendChild(domainRow(domain, secs));
      }
      section.appendChild(details);

      toggle.addEventListener("click", () => details.classList.toggle("hidden"));
    }

    container.appendChild(section);
  }

  if (!any) {
    container.innerHTML = '<div class="empty-state">Nothing recorded yet.</div>';
  }
}

function domainRow(domain, seconds) {
  const row = document.createElement("div");
  row.className = "domain-row";
  const nameEl = document.createElement("span");
  nameEl.className = "domain-name";
  nameEl.textContent = domain;
  const timeEl = document.createElement("span");
  timeEl.className = "domain-time";
  timeEl.textContent = formatDuration(seconds);
  row.appendChild(nameEl);
  row.appendChild(timeEl);
  return row;
}

function render(byDay, range) {
  const today = new Date();
  const keys = range === "week" ? weekDayKeys(today) : [dayKey(today)];
  const totals = aggregate(byDay, keys);

  const byCategory = {};
  for (const category of CATEGORIES) byCategory[category] = [];
  for (const [domain, seconds] of Object.entries(totals)) {
    byCategory[categorizeDomain(domain)].push([domain, seconds]);
  }

  renderChart(byCategory);
  renderSections(byCategory);
}

let currentByDay = {};
let currentRange = "day";

const dayBtn = document.getElementById("range-day-btn");
const weekBtn = document.getElementById("range-week-btn");

dayBtn.addEventListener("click", () => {
  currentRange = "day";
  dayBtn.classList.add("selected");
  weekBtn.classList.remove("selected");
  render(currentByDay, currentRange);
});

weekBtn.addEventListener("click", () => {
  currentRange = "week";
  weekBtn.classList.add("selected");
  dayBtn.classList.remove("selected");
  render(currentByDay, currentRange);
});

const categoryWarning = document.getElementById("category-warning");
const categoryRetryBtn = document.getElementById("category-retry-btn");

function setCategoryWarningVisible(visible) {
  categoryWarning.classList.toggle("visible", visible);
}

async function loadAndRender() {
  const ok = await loadDomainCategories();
  setCategoryWarningVisible(!ok);
  render(currentByDay, currentRange);
}

categoryRetryBtn.addEventListener("click", () => {
  loadAndRender();
});

chrome.runtime.sendMessage({ type: "getScreenTime" }, (response) => {
  currentByDay = response?.byDay || {};
  loadAndRender();
});
