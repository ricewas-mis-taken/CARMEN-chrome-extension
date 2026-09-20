// Hand-curated seed list of well-known domains by category -- kept in sync
// with carmen-desktop's screentime_domains.json by hand (see that file's
// own comment for why this isn't a purchased/scraped ~20k-domain dataset).
// Anything not listed here falls back to "Other".
const DOMAIN_CATEGORIES = {
  "youtube.com": "Entertainment", "netflix.com": "Entertainment", "hulu.com": "Entertainment",
  "disneyplus.com": "Entertainment", "twitch.tv": "Entertainment", "spotify.com": "Entertainment",
  "soundcloud.com": "Entertainment", "tiktok.com": "Entertainment", "instagram.com": "Entertainment",
  "facebook.com": "Entertainment", "twitter.com": "Entertainment", "x.com": "Entertainment",
  "reddit.com": "Entertainment", "pinterest.com": "Entertainment", "tumblr.com": "Entertainment",
  "imgur.com": "Entertainment", "9gag.com": "Entertainment", "vimeo.com": "Entertainment",
  "dailymotion.com": "Entertainment", "primevideo.com": "Entertainment", "hbomax.com": "Entertainment",
  "max.com": "Entertainment", "peacocktv.com": "Entertainment", "crunchyroll.com": "Entertainment",
  "funimation.com": "Entertainment", "imdb.com": "Entertainment", "rottentomatoes.com": "Entertainment",
  "buzzfeed.com": "Entertainment", "giphy.com": "Entertainment", "snapchat.com": "Entertainment",
  "discord.com": "Entertainment", "pandora.com": "Entertainment", "deezer.com": "Entertainment",
  "tunein.com": "Entertainment", "vevo.com": "Entertainment", "metacritic.com": "Entertainment",
  "letterboxd.com": "Entertainment", "plex.tv": "Entertainment", "weibo.com": "Entertainment",
  "vk.com": "Entertainment", "bilibili.com": "Entertainment", "iqiyi.com": "Entertainment",
  "hotstar.com": "Entertainment", "disney.com": "Entertainment",

  "khanacademy.org": "Education", "coursera.org": "Education", "edx.org": "Education",
  "udemy.com": "Education", "udacity.com": "Education", "duolingo.com": "Education",
  "quizlet.com": "Education", "chegg.com": "Education", "brainly.com": "Education",
  "wikipedia.org": "Education", "wikihow.com": "Education", "britannica.com": "Education",
  "wolframalpha.com": "Education", "codecademy.com": "Education", "freecodecamp.org": "Education",
  "w3schools.com": "Education", "geeksforgeeks.org": "Education", "ted.com": "Education",
  "coursehero.com": "Education", "jstor.org": "Education", "sparknotes.com": "Education",
  "cliffsnotes.com": "Education", "mathway.com": "Education", "desmos.com": "Education",
  "quizizz.com": "Education", "kahoot.com": "Education", "instructure.com": "Education",
  "blackboard.com": "Education", "moodle.org": "Education", "edmodo.com": "Education",
  "byjus.com": "Education", "skillshare.com": "Education", "pluralsight.com": "Education",
  "masterclass.com": "Education", "brilliant.org": "Education", "quora.com": "Education",
  "stackexchange.com": "Education", "researchgate.net": "Education", "academia.edu": "Education",
  "arxiv.org": "Education", "grammarly.com": "Education",

  "steampowered.com": "Games", "epicgames.com": "Games", "roblox.com": "Games",
  "minecraft.net": "Games", "ea.com": "Games", "origin.com": "Games", "battle.net": "Games",
  "blizzard.com": "Games", "riotgames.com": "Games", "leagueoflegends.com": "Games",
  "playvalorant.com": "Games", "playstation.com": "Games", "xbox.com": "Games",
  "nintendo.com": "Games", "ign.com": "Games", "gamespot.com": "Games", "kotaku.com": "Games",
  "polygon.com": "Games", "chess.com": "Games", "lichess.org": "Games", "miniclip.com": "Games",
  "kongregate.com": "Games", "addictinggames.com": "Games", "crazygames.com": "Games",
  "poki.com": "Games", "itch.io": "Games", "gog.com": "Games", "humblebundle.com": "Games",
  "ubisoft.com": "Games", "activision.com": "Games", "rockstargames.com": "Games",
  "fortnite.com": "Games", "hypixel.net": "Games", "osu.ppy.sh": "Games", "pokemon.com": "Games",
  "coolmathgames.com": "Games", "y8.com": "Games",

  "github.com": "Tools", "gitlab.com": "Tools", "bitbucket.org": "Tools", "stackoverflow.com": "Tools",
  "google.com": "Tools", "docs.google.com": "Tools", "drive.google.com": "Tools",
  "sheets.google.com": "Tools", "mail.google.com": "Tools", "gmail.com": "Tools",
  "outlook.com": "Tools", "office.com": "Tools", "notion.so": "Tools", "slack.com": "Tools",
  "zoom.us": "Tools", "dropbox.com": "Tools", "trello.com": "Tools", "asana.com": "Tools",
  "figma.com": "Tools", "canva.com": "Tools", "adobe.com": "Tools", "atlassian.com": "Tools",
  "jira.com": "Tools", "confluence.com": "Tools", "amazon.com": "Tools", "npmjs.com": "Tools",
  "pypi.org": "Tools", "docker.com": "Tools", "kubernetes.io": "Tools", "digitalocean.com": "Tools",
  "cloudflare.com": "Tools", "vercel.com": "Tools", "netlify.com": "Tools", "heroku.com": "Tools",
  "postman.com": "Tools", "replit.com": "Tools", "codepen.io": "Tools", "jsfiddle.net": "Tools",
  "chatgpt.com": "Tools", "openai.com": "Tools", "claude.ai": "Tools", "anthropic.com": "Tools",
  "wordpress.com": "Tools", "squarespace.com": "Tools", "wix.com": "Tools", "mailchimp.com": "Tools",
  "hubspot.com": "Tools", "salesforce.com": "Tools", "zendesk.com": "Tools", "calendly.com": "Tools",
  "linkedin.com": "Tools", "indeed.com": "Tools", "glassdoor.com": "Tools", "paypal.com": "Tools",
  "stripe.com": "Tools", "ebay.com": "Tools", "docusign.com": "Tools", "evernote.com": "Tools",
  "todoist.com": "Tools", "monday.com": "Tools", "airtable.com": "Tools", "zapier.com": "Tools",
  "1password.com": "Tools", "lastpass.com": "Tools", "protonmail.com": "Tools", "yahoo.com": "Tools",
  "bing.com": "Tools", "duckduckgo.com": "Tools",
};

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
  row.innerHTML = `<span class="domain-name">${domain}</span><span class="domain-time">${formatDuration(seconds)}</span>`;
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

chrome.runtime.sendMessage({ type: "getScreenTime" }, (response) => {
  currentByDay = response?.byDay || {};
  render(currentByDay, currentRange);
});
