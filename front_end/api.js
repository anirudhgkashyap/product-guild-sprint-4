/**
 * api.js — everything that talks to the outside world.
 *
 * Two backends are in play, on purpose:
 *  1. FastAPI (`Api.*`)     — for mutations that carry real business
 *     logic: auth, creating matters, committing versions (which also
 *     has to touch Storage), signatures.
 *  2. Supabase directly (`Db.*`) — for plain reads/writes that are
 *     already fully governed by RLS and don't have a FastAPI route
 *     yet (matter participants, profiles, comments, signed download
 *     links). Uses the anon key + the user's own logged-in session,
 *     so it's exactly as safe as going through the API.
 */

const cfg = window.APP_CONFIG;

/* ----------------------------- session ----------------------------- */

const Auth = {
  getToken() {
    return localStorage.getItem("gfl_access_token");
  },
  getRefreshToken() {
    return localStorage.getItem("gfl_refresh_token");
  },
  getUser() {
    try {
      return JSON.parse(localStorage.getItem("gfl_user"));
    } catch {
      return null;
    }
  },
  setSession(user, access_token, refresh_token) {
    localStorage.setItem("gfl_user", JSON.stringify(user));
    localStorage.setItem("gfl_access_token", access_token);
    if (refresh_token) localStorage.setItem("gfl_refresh_token", refresh_token);
  },
  clear() {
    localStorage.removeItem("gfl_user");
    localStorage.removeItem("gfl_access_token");
    localStorage.removeItem("gfl_refresh_token");
  },
  requireAuth() {
    if (!this.getToken()) {
      window.location.href = "login.html";
    }
  },
  initials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  },
};

/* ---------------------------- FastAPI -------------------------------- */

async function apiFetch(path, options = {}) {
  const token = Auth.getToken();
  const headers = Object.assign({}, options.headers || {});
  const isFormData = options.body instanceof FormData;
  if (!isFormData) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${cfg.API_BASE}${path}`, { ...options, headers });
  } catch (networkErr) {
    // fetch() throws (rather than resolving with a bad status) when the
    // request never reached a server at all — wrong API_BASE, backend
    // not deployed/running, or a CORS preflight got blocked.
    throw new Error(
      `Can't reach the API at "${cfg.API_BASE}${path}". Confirm the backend is running/deployed there, ` +
        `and that it allows requests from this page's origin (CORS).`
    );
  }

  if (res.status === 401) {
    Auth.clear();
    window.location.href = "login.html";
    throw new Error("Session expired — please sign in again.");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const Api = {
  login: (email, password) =>
    apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  signup: (email, password, full_name) =>
    apiFetch("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, full_name }) }),

  listMatters: () => apiFetch("/matters"),
  getMatter: (id) => apiFetch(`/matters/${id}`),
  createMatter: (title, description) =>
    apiFetch("/matters", { method: "POST", body: JSON.stringify({ title, description }) }),
  addParticipant: (matterId, user_id, side) =>
    apiFetch(`/matters/${matterId}/participants`, {
      method: "POST",
      body: JSON.stringify({ user_id, side }),
    }),
  updateMatterStatus: (matterId, new_status) =>
    apiFetch(`/matters/${matterId}/status?new_status=${encodeURIComponent(new_status)}`, {
      method: "PATCH",
    }),

  listVersions: (matterId) => apiFetch(`/matters/${matterId}/versions`),
  getVersion: (versionId) => apiFetch(`/versions/${versionId}`),
  getVersionDiff: (versionId) => apiFetch(`/versions/${versionId}/diff`),
  commitVersion: (formData) => apiFetch("/versions", { method: "POST", body: formData }),

  createSignatureRequest: (matter_id, version_id, provider = "mock") =>
    apiFetch("/signatures", {
      method: "POST",
      body: JSON.stringify({ matter_id, version_id, provider }),
    }),
  updateSignatureStatus: (requestId, status) =>
    apiFetch(`/signatures/${requestId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  getSignatureStatus: (versionId) => apiFetch(`/versions/${versionId}/signature-status`),
};

/* --------------------------- Supabase direct -------------------------- */

let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  if (!window.supabase || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    return null; // not configured yet — callers fall back gracefully
  }
  _sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  const access_token = Auth.getToken();
  const refresh_token = Auth.getRefreshToken();
  if (access_token && refresh_token) {
    _sb.auth.setSession({ access_token, refresh_token });
  }
  return _sb;
}

const Db = {
  /** Other participants + profile names for a matter. RLS-scoped. */
  async getParticipants(matterId) {
    const sb = getSupabase();
    if (!sb) return [];
    const { data, error } = await sb
      .from("matter_participants")
      .select("user_id, side, profiles(full_name, law_firm)")
      .eq("matter_id", matterId);
    if (error) {
      console.warn("getParticipants failed:", error.message);
      return [];
    }
    return data.map((row) => ({
      user_id: row.user_id,
      side: row.side,
      full_name: row.profiles?.full_name || null,
      law_firm: row.profiles?.law_firm || null,
    }));
  },

  async getProfile(userId) {
    const sb = getSupabase();
    if (!sb) return null;
    const { data, error } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) return null;
    return data;
  },

  async listComments(versionId) {
    const sb = getSupabase();
    if (!sb) return [];
    const { data, error } = await sb
      .from("comments")
      .select("id, body, created_at, user_id, profiles(full_name)")
      .eq("version_id", versionId)
      .order("created_at", { ascending: true });
    if (error) {
      console.warn("listComments failed:", error.message);
      return [];
    }
    return data;
  },

  async addComment(versionId, matterId, userId, body) {
    const sb = getSupabase();
    if (!sb) throw new Error("Comments need Supabase configured — see config.js");
    const { data, error } = await sb
      .from("comments")
      .insert({ version_id: versionId, matter_id: matterId, user_id: userId, body })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  },

  async getSignedDownloadUrl(filePath) {
    const sb = getSupabase();
    if (!sb) return null;
    const { data, error } = await sb.storage
      .from(cfg.STORAGE_BUCKET)
      .createSignedUrl(filePath, 120);
    if (error) {
      console.warn("createSignedUrl failed:", error.message);
      return null;
    }
    return data.signedUrl;
  },

  async downloadFile(filePath) {
    const sb = getSupabase();
    if (!sb) return null;
    const { data, error } = await sb.storage.from(cfg.STORAGE_BUCKET).download(filePath);
    if (error) {
      console.warn("download failed:", error.message);
      return null;
    }
    return data; // Blob
  },
};

/* ----------------------------- utils ----------------------------- */

function timeAgo(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function renderSidebar(activeKey) {
  const user = Auth.getUser();
  const el = document.getElementById("sidebar");
  if (!el) return;
  const items = [
    { key: "active", label: "Active Negotiations", href: "dashboard.html" },
    { key: "drafts", label: "Drafts", href: "dashboard.html?tab=drafts" },
    { key: "done", label: "Completed / Signed", href: "dashboard.html?tab=done" },
  ];
  const intel = [
    { key: "playbooks", label: "Playbooks", href: "#" },
    { key: "counterparties", label: "Counterparties", href: "#" },
  ];
  const navHtml = (arr) =>
    arr
      .map(
        (i) => `
        <a class="nav-item ${i.key === activeKey ? "active" : ""}" href="${i.href}">
          <span class="dot"></span>${i.label}
        </a>`
      )
      .join("");

  el.innerHTML = `
    <div class="sidebar-logo"><span class="mark"></span>PLATFORM</div>
    <div class="nav-group">${navHtml(items)}</div>
    <div class="nav-label">LEGAL INTELLIGENCE</div>
    <div class="nav-group">${navHtml(intel)}</div>
    <div class="sidebar-spacer"></div>
    <div class="nav-group">
      <a class="nav-item" href="#" id="settings-link"><span class="dot"></span>Settings</a>
    </div>
    <div class="sidebar-user">
      <div class="avatar">${Auth.initials(user?.email)}</div>
      <div class="who">
        <div class="name">${escapeHtml(user?.email || "Signed in")}</div>
        <button class="signout" id="signout-btn">Sign out</button>
      </div>
    </div>
  `;
  document.getElementById("signout-btn")?.addEventListener("click", () => {
    Auth.clear();
    window.location.href = "login.html";
  });
}
