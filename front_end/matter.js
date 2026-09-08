Auth.requireAuth();
renderSidebar("active");

const me = Auth.getUser();
const matterId = qs("matter_id");
if (!matterId) window.location.href = "dashboard.html";

let matter = null;
let versions = [];
let participants = [];
let selectedForCompare = new Set();
let activeCommentVersionId = null;

async function load() {
  try {
    [matter, versions, participants] = await Promise.all([
      Api.getMatter(matterId),
      Api.listVersions(matterId),
      Db.getParticipants(matterId),
    ]);
  } catch (err) {
    document.getElementById("matter-title").textContent = "Couldn't load this matter";
    document.getElementById("matter-meta").textContent = err.message;
    return;
  }

  document.title = `${matter.title} — Platform`;
  document.getElementById("crumb-title").textContent = matter.title;
  document.getElementById("matter-title").textContent = matter.title;

  const counterparty = participants.find((p) => p.user_id !== me?.id);
  const latest = versions[versions.length - 1] || null;
  const myTurn = latest && latest.committed_by !== me?.id;
  const startedAgo = timeAgo(matter.created_at);
  document.getElementById("matter-meta").textContent =
    `${versions.length} version${versions.length === 1 ? "" : "s"} · started ${startedAgo}` +
    (latest ? (myTurn ? " · your turn to respond" : " · awaiting counterparty") : "");

  renderBanner(latest, counterparty);
  renderParties(counterparty);
  renderTimeline();

  activeCommentVersionId = latest?.id || null;
  renderComments();
}

function renderBanner(latest, counterparty) {
  const slot = document.getElementById("banner-slot");
  if (!latest || latest.committed_by === me?.id) {
    slot.innerHTML = "";
    return;
  }
  const who = counterparty?.full_name || "The counterparty";
  slot.innerHTML = `
    <div class="banner">
      <span class="dot-live"></span>
      ${escapeHtml(who)} committed <strong>v${versionNumberOf(latest.id)}</strong> ${timeAgo(latest.created_at)}
      ${latest.commit_message ? `— "${escapeHtml(latest.commit_message)}"` : ""}
    </div>`;
}

function renderParties(counterparty) {
  const el = document.getElementById("parties-list");
  if (participants.length === 0) {
    el.innerHTML = `<div class="muted" style="font-size:13px;">No participants loaded. ${
      !window.APP_CONFIG.SUPABASE_URL.includes("YOUR-PROJECT")
        ? "None invited yet."
        : "Add your Supabase URL/key in config.js to see parties."
    }</div>`;
    return;
  }
  el.innerHTML = participants
    .map((p) => {
      const isMe = p.user_id === me?.id;
      return `<div class="party-row">
        <div class="avatar" style="width:22px;height:22px;font-size:10px;">${Auth.initials(p.full_name || "?")}</div>
        ${escapeHtml(isMe ? "You" : p.full_name || "Unnamed participant")}
        ${p.law_firm && !isMe ? `<span class="muted" style="font-size:12px;"> · ${escapeHtml(p.law_firm)}</span>` : ""}
        <span class="side-tag">${p.side === "drafting" ? "Drafting" : "Counterparty"}</span>
      </div>`;
    })
    .join("");
}

function versionNumberOf(versionId) {
  const idx = versions.findIndex((v) => v.id === versionId);
  return idx === -1 ? "?" : idx + 1;
}

function renderTimeline() {
  const el = document.getElementById("timeline");
  if (versions.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <h3>No versions yet</h3>
      <p>Commit the first draft to kick off the negotiation.</p>
      <button class="btn btn-primary" onclick="window.location.href='commit.html?matter_id=${matterId}'">Commit New Version</button>
    </div>`;
    return;
  }

  const ordered = [...versions].reverse(); // newest first, like the mockup
  el.innerHTML = `<div class="timeline-rail"></div>` +
    ordered
      .map((v, i) => {
        const num = versions.length - i;
        const isLatest = i === 0;
        const isMine = v.committed_by === me?.id;
        const committerName = isMine ? "you" : participantName(v.committed_by);
        const parent = versions.find((x) => x.id === v.parent_version_id);
        const parentNum = parent ? versionNumberOf(parent.id) : null;

        return `
        <div class="version-row ${isLatest ? "" : "is-old"}">
          <div class="version-dot"></div>
          <div class="version-card">
            <div class="version-card-head">
              <div>
                <div class="v-title">v${num}${isLatest ? "" : ""}</div>
                <div class="v-meta">Committed ${timeAgo(v.created_at)} by ${escapeHtml(isMine ? "you" : committerName)}</div>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                ${isMine ? '<span class="you-pill">You</span>' : ""}
                <label class="checkbox-row" style="font-size:12px; color:var(--gray-500);">
                  <input type="checkbox" class="compare-check" data-id="${v.id}" ${
                    selectedForCompare.has(v.id) ? "checked" : ""
                  } /> select
                </label>
              </div>
            </div>
            ${v.commit_message ? `<div class="commit-msg">"${escapeHtml(v.commit_message)}"</div>` : ""}
            <div class="version-actions">
              <button class="btn btn-secondary btn-sm" data-action="download" data-id="${v.id}">Download to Word</button>
              ${
                parentNum
                  ? `<button class="btn btn-secondary btn-sm" data-action="compare-prev" data-from="${parent.id}" data-to="${v.id}">Compare to v${parentNum}</button>`
                  : ""
              }
              <button class="btn btn-secondary btn-sm" data-action="comment" data-id="${v.id}">Comment</button>
              ${
                !isLatest
                  ? `<button class="btn btn-secondary btn-sm" data-action="restore" data-id="${v.id}">Restore this version</button>`
                  : ""
              }
            </div>
          </div>
        </div>`;
      })
      .join("");

  // wire up actions
  el.querySelectorAll('[data-action="download"]').forEach((btn) =>
    btn.addEventListener("click", () => downloadVersion(btn.dataset.id))
  );
  el.querySelectorAll('[data-action="compare-prev"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      window.location.href = `compare.html?matter_id=${matterId}&from=${btn.dataset.from}&to=${btn.dataset.to}`;
    })
  );
  el.querySelectorAll('[data-action="comment"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      activeCommentVersionId = btn.dataset.id;
      renderComments();
      document.getElementById("comment-input").focus();
    })
  );
  el.querySelectorAll('[data-action="restore"]').forEach((btn) =>
    btn.addEventListener("click", () => restoreVersion(btn.dataset.id))
  );
  el.querySelectorAll(".compare-check").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (selectedForCompare.size >= 2) {
          cb.checked = false;
          return;
        }
        selectedForCompare.add(cb.dataset.id);
      } else {
        selectedForCompare.delete(cb.dataset.id);
      }
      document.getElementById("compare-btn").disabled = selectedForCompare.size !== 2;
    })
  );
}

function participantName(userId) {
  const p = participants.find((x) => x.user_id === userId);
  return p?.full_name || "counterparty";
}

async function downloadVersion(versionId) {
  const v = versions.find((x) => x.id === versionId);
  if (!v) return;
  const url = await Db.getSignedDownloadUrl(v.file_path);
  if (url) {
    window.open(url, "_blank");
  } else {
    alert(
      "Couldn't generate a download link. Configure SUPABASE_URL / SUPABASE_ANON_KEY in config.js to enable direct downloads from Storage."
    );
  }
}

async function restoreVersion(versionId) {
  const v = versions.find((x) => x.id === versionId);
  const latest = versions[versions.length - 1];
  if (!v || !confirm(`Restore v${versionNumberOf(v.id)} as a new commit on top of v${versionNumberOf(latest.id)}?`)) return;

  const blob = await Db.downloadFile(v.file_path);
  if (!blob) {
    alert("Couldn't fetch that version's file. Configure Supabase in config.js to enable restore.");
    return;
  }
  const formData = new FormData();
  formData.append("matter_id", matterId);
  formData.append("commit_message", `Restored from v${versionNumberOf(v.id)}`);
  formData.append("parent_version_id", latest.id);
  formData.append("file", blob, v.file_name);

  try {
    await Api.commitVersion(formData);
    load();
  } catch (err) {
    alert(`Couldn't restore: ${err.message}`);
  }
}

function renderComments() {
  const title = document.getElementById("comments-title");
  const num = activeCommentVersionId ? versionNumberOf(activeCommentVersionId) : "—";
  title.textContent = `COMMENTS ON V${num}`;

  const list = document.getElementById("comments-list");
  if (!activeCommentVersionId) {
    list.innerHTML = `<div class="muted" style="font-size:13px;">No version selected.</div>`;
    return;
  }
  list.innerHTML = `<div class="muted" style="font-size:13px;">Loading…</div>`;
  Db.listComments(activeCommentVersionId).then((comments) => {
    if (comments.length === 0) {
      list.innerHTML = `<div class="muted" style="font-size:13px;">No comments yet.</div>`;
      return;
    }
    list.innerHTML = comments
      .map(
        (c) => `
      <div class="comment-item">
        <div class="c-head">${escapeHtml(c.profiles?.full_name || "Someone")} <span>· ${timeAgo(c.created_at)}</span></div>
        <div class="c-body">${escapeHtml(c.body)}</div>
      </div>`
      )
      .join("");
  });
}

document.getElementById("comment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("comment-input");
  const body = input.value.trim();
  if (!body || !activeCommentVersionId) return;
  try {
    await Db.addComment(activeCommentVersionId, matterId, me.id, body);
    input.value = "";
    renderComments();
  } catch (err) {
    alert(`Couldn't post comment: ${err.message}`);
  }
});

document.getElementById("commit-btn").addEventListener("click", () => {
  const latest = versions[versions.length - 1];
  const parentParam = latest ? `&parent_version_id=${latest.id}` : "";
  window.location.href = `commit.html?matter_id=${matterId}${parentParam}`;
});

document.getElementById("compare-btn").addEventListener("click", () => {
  if (selectedForCompare.size !== 2) return;
  const [a, b] = [...selectedForCompare];
  const aNum = versionNumberOf(a);
  const bNum = versionNumberOf(b);
  const [from, to] = aNum < bNum ? [a, b] : [b, a];
  window.location.href = `compare.html?matter_id=${matterId}&from=${from}&to=${to}`;
});

load();
