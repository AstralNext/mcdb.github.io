const SEARCH_URL = "https://search.mcdb.astral.fan/v1/search";
const BROWSE_URL = "https://search.mcdb.astral.fan/v1/browse";
const TYPES_URL = "/api/v1/titles/types.json";
const PAGE_SIZE = 50;

const TYPE_LABELS = {
  mod: "模组",
  modpack: "整合包",
  resourcepack: "资源包",
  datapack: "数据包",
  shader: "着色器",
  plugin: "插件",
  minecraft_java_server: "服务器",
};

const state = {
  mode: "browse",
  type: null,
  query: "",
  page: 0,
  total: 0,
  pages: 0,
  types: [],
  loading: false,
};

const els = {
  form: document.getElementById("search-form"),
  input: document.getElementById("q"),
  catList: document.getElementById("cat-list"),
  results: document.getElementById("results"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
  pager: document.getElementById("pager"),
  prev: document.getElementById("prev-page"),
  next: document.getElementById("next-page"),
};

function labelType(id) {
  return TYPE_LABELS[id] || id || "其它";
}

function formatCount(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
  return n.toLocaleString("zh-CN");
}

function modrinthUrl(item) {
  if (!item.slug) return null;
  const t = item.type || "mod";
  const pathType = t === "resourcepack" ? "resourcepack" : t === "modpack" ? "modpack" : t === "shader" ? "shader" : t === "datapack" ? "datapack" : "mod";
  return `https://modrinth.com/${pathType}/${item.slug}`;
}

function renderCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  const modrinth = modrinthUrl(item);
  card.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-zh">${escapeHtml(item.zh || "—")}</div>
        <div class="card-en">${escapeHtml(item.en || "")}</div>
      </div>
    </div>
    <div class="card-meta">
      <span class="tag type">${escapeHtml(labelType(item.type))}</span>
      ${item.slug ? `<span class="tag">${escapeHtml(item.slug)}</span>` : ""}
      <span class="tag" title="项目 ID">${escapeHtml(item.id || "")}</span>
      ${item.score != null ? `<span class="tag">score ${item.score}</span>` : ""}
    </div>
    <div class="card-links">
      ${modrinth ? `<a href="${modrinth}" target="_blank" rel="noopener">Modrinth</a>` : ""}
      <a href="/api.html#i18n">I18n API</a>
    </div>
  `;
  return card;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setError(msg) {
  if (!msg) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.hidden = false;
  els.error.textContent = msg;
}

function renderCategories() {
  els.catList.innerHTML = "";
  const allBtn = document.createElement("li");
  allBtn.innerHTML = `<button type="button" class="cat-btn${state.type ? "" : " active"}" data-type="">全部</button>`;
  els.catList.appendChild(allBtn);

  for (const t of state.types) {
    const li = document.createElement("li");
    li.innerHTML = `
      <button type="button" class="cat-btn${state.type === t.id ? " active" : ""}" data-type="${escapeHtml(t.id)}">
        <span>${escapeHtml(t.label || labelType(t.id))}</span>
        <span class="cat-count">${formatCount(t.count)}</span>
      </button>`;
    els.catList.appendChild(li);
  }

  els.catList.querySelectorAll(".cat-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.type = btn.dataset.type || null;
      state.page = 0;
      state.query = "";
      els.input.value = "";
      renderCategories();
      if (state.type) {
        state.mode = "browse";
        loadBrowse();
      } else {
        showHome();
      }
    });
  });
}

function showHome() {
  state.mode = "home";
  els.status.textContent = "选择左侧分类浏览，或在上方搜索中英文标题";
  els.results.innerHTML = `
    <div class="empty">
      <p>MCDB 收录 Modrinth 等平台项目的中英对照译名。</p>
      <p>输入关键词后按 <strong>Enter</strong> 搜索；API 见 <a href="/api.html">文档</a>。</p>
    </div>`;
  els.pager.hidden = true;
  setError("");
}

function updateStatus(text) {
  els.status.textContent = text;
}

function updatePager() {
  if (state.mode !== "browse" || !state.type) {
    els.pager.hidden = true;
    return;
  }
  els.pager.hidden = false;
  els.prev.disabled = state.page <= 0 || state.loading;
  els.next.disabled = state.page + 1 >= state.pages || state.loading;
}

async function loadTypes() {
  const res = await fetch(TYPES_URL);
  if (!res.ok) throw new Error(`无法加载分类目录 (${res.status})`);
  const data = await res.json();
  state.types = data.types || [];
  renderCategories();
}

async function loadBrowse() {
  if (!state.type) return showHome();
  state.mode = "browse";
  state.loading = true;
  setError("");
  updateStatus(`正在加载 ${labelType(state.type)}…`);
  els.results.innerHTML = `<div class="empty loading">加载中</div>`;
  updatePager();

  try {
    const url = `${BROWSE_URL}?type=${encodeURIComponent(state.type)}&page=${state.page}&limit=${PAGE_SIZE}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `浏览失败 (${res.status})`);

    state.total = data.total || 0;
    state.pages = data.pages || 0;
    const items = data.items || [];
    els.results.innerHTML = "";
    if (!items.length) {
      els.results.innerHTML = `<div class="empty">该分类暂无条目</div>`;
    } else {
      items.forEach((item) => els.results.appendChild(renderCard(item)));
    }
    updateStatus(
      `${labelType(state.type)} · 第 ${state.page + 1}/${Math.max(state.pages, 1)} 页 · 共 ${formatCount(state.total)} 条`,
    );
  } catch (e) {
    setError(String(e.message || e));
    els.results.innerHTML = `<div class="empty">加载失败</div>`;
  } finally {
    state.loading = false;
    updatePager();
  }
}

async function loadSearch() {
  const q = state.query.trim();
  if (!q) return;
  state.mode = "search";
  state.loading = true;
  setError("");
  updateStatus(`搜索「${q}」…`);
  els.results.innerHTML = `<div class="empty loading">搜索中</div>`;
  els.pager.hidden = true;

  try {
    const body = { q, limit: 50 };
    if (state.type) body.type = state.type;
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `搜索失败 (${res.status})`);

    const hits = data.hits || [];
    els.results.innerHTML = "";
    if (!hits.length) {
      els.results.innerHTML = `<div class="empty">未找到匹配「${escapeHtml(q)}」的项目</div>`;
    } else {
      hits.forEach((item) => els.results.appendChild(renderCard(item)));
    }
    const typeHint = state.type ? ` · ${labelType(state.type)}` : "";
    updateStatus(`「${q}」${typeHint} · ${hits.length} 条结果`);
  } catch (e) {
    setError(String(e.message || e));
    els.results.innerHTML = `<div class="empty">搜索失败</div>`;
  } finally {
    state.loading = false;
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  state.query = els.input.value.trim();
  state.page = 0;
  if (!state.query) return;
  state.mode = "search";
  loadSearch();
});

els.prev.addEventListener("click", () => {
  if (state.page > 0) {
    state.page -= 1;
    loadBrowse();
  }
});

els.next.addEventListener("click", () => {
  if (state.page + 1 < state.pages) {
    state.page += 1;
    loadBrowse();
  }
});

loadTypes()
  .then(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get("q");
    const type = params.get("type");
    if (type) {
      state.type = type;
      renderCategories();
      loadBrowse();
    } else if (q) {
      state.query = q;
      els.input.value = q;
      loadSearch();
    } else {
      showHome();
    }
  })
  .catch((e) => {
    setError(String(e.message || e));
    showHome();
  });
