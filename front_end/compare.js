Auth.requireAuth();
renderSidebar("active");

const me = Auth.getUser();
const matterId = qs("matter_id");
if (!matterId) window.location.href = "dashboard.html";

const SIG_STEPS = ["sent", "viewed", "signed", "completed"];

let matter, versions, participants;

async function init() {
  try {
    [matter, versions, participants] = await Promise.all([
      Api.getMatter(matterId),
      Api.listVersions(matterId),
      Db.getParticipants(matterId),
    ]);
  } catch (err) {
    document.querySelector(".page-title").textContent = "Couldn't load this comparison";
    document.querySelector(".page-subtitle").textContent = err.message;
    return;
  }

  document.getElementById("crumb-matter").textContent = matter.title;
  document.getElementById("crumb-matter").href = `matter.html?matter_id=${matterId}`;

  if (versions.length < 2) {
    document.querySelector(".compare-select-row").style.display = "none";
    document.getElementById("from-diff").innerHTML = "";
    document.getElementById("to-diff").innerHTML = "";
    document.querySelector(".compare-panels").innerHTML = `<div class="card card-inner" style="grid-column: 1 / -1;">
      <h3>Not enough versions yet</h3>
      <p>Commit at least two versions on this matter before comparing.</p>
    </div>`;
  } else {
    populateSelects();
    document.getElementById("from-select").addEventListener("change", renderDiffs);
    document.getElementById("to-select").addEventListener("change", renderDiffs);
    renderDiffs();
  }

  wireFinalizeAndSignature();
}

function populateSelects() {
  const fromSel = document.getElementById("from-select");
  const toSel = document.getElementById("to-select");
  const opts = versions
    .map((v, i) => `<option value="${v.id}">v${i + 1}${i === versions.length - 1 ? " (latest)" : ""}</option>`)
    .join("");
  fromSel.innerHTML = opts;
  toSel.innerHTML = opts;

  const fromParam = qs("from");
  const toParam = qs("to");
  fromSel.value = fromParam && versions.some((v) => v.id === fromParam) ? fromParam : versions[0].id;
  toSel.value = toParam && versions.some((v) => v.id === toParam) ? toParam : versions[versions.length - 1].id;
}

function versionLabel(versionId) {
  const idx = versions.findIndex((v) => v.id === versionId);
  return idx === -1 ? "?" : `v${idx + 1}`;
}

async function renderDiffs() {
  const fromId = document.getElementById("from-select").value;
  const toId = document.getElementById("to-select").value;
  document.getElementById("from-label").textContent = versionLabel(fromId);
  document.getElementById("to-label").textContent = `${versionLabel(toId)}${toId === versions[versions.length - 1].id ? " (latest)" : ""}`;

  const fromEl = document.getElementById("from-diff");
  const toEl = document.getElementById("to-diff");
  fromEl.innerHTML = `<div class="loading-row">Loading…</div>`;
  toEl.innerHTML = `<div class="loading-row">Loading…</div>`;

  // The parser extracts tracked-changes fragments from a single .docx's
  // XML (word/document.xml) — it doesn't reconstruct two full documents
  // for an arbitrary version pair. So both panels are built from the
  // "to" version's own tracked changes: the FROM panel shows what it
  // deleted, the TO panel shows what it inserted.
  try {
    const diff = await Api.getVersionDiff(toId);
    if (!diff.has_tracked_changes) {
      const msg = `<div class="muted" style="font-size:13px;">No tracked changes found in this file.</div>`;
      fromEl.innerHTML = msg;
      toEl.innerHTML = msg;
      return;
    }
    const deletions = diff.revisions.filter((r) => r.change_type === "deletion");
    const insertions = diff.revisions.filter((r) => r.change_type === "insertion");
    fromEl.innerHTML = renderRevisionList(deletions, "del") ||
      `<div class="muted" style="font-size:13px;">No deletions in this commit.</div>`;
    toEl.innerHTML = renderRevisionList(insertions, "ins") ||
      `<div class="muted" style="font-size:13px;">No insertions in this commit.</div>`;
  } catch (err) {
    const msg = `<div class="muted" style="font-size:13px;">Couldn't load redline: ${escapeHtml(err.message)}</div>`;
    fromEl.innerHTML = msg;
    toEl.innerHTML = msg;
  }
}

function renderRevisionList(revisions, kind) {
  if (revisions.length === 0) return "";
  return revisions
    .map(
      (r) => `
      <div class="diff-para">
        <span class="p-idx">Paragraph ${r.paragraph_index + 1} · ${escapeHtml(r.author || "unknown")} · ${
        r.date ? timeAgo(r.date) : "no date"
      }</span>
        <span class="diff-${kind}">${escapeHtml(r.text)}</span>
      </div>`
    )
    .join("");
}

/* -------------------- finalize + e-signature -------------------- */

function wireFinalizeAndSignature() {
  document.getElementById("not-yet-btn").addEventListener("click", () => {
    window.location.href = `matter.html?matter_id=${matterId}`;
  });

  document.getElementById("mark-final-btn").addEventListener("click", async () => {
    const btn = document.getElementById("mark-final-btn");
    btn.disabled = true;
    btn.textContent = "Marking…";
    try {
      await Api.updateMatterStatus(matterId, "executed");
      btn.textContent = "Marked as final ✓";
    } catch (err) {
      alert(`Couldn't mark as final: ${err.message}`);
      btn.disabled = false;
      btn.textContent = "Mark as final";
    }
  });

  loadSignatureCard();
}

async function loadSignatureCard() {
  const latest = versions[versions.length - 1];
  if (!latest) return;
  let status = null;
  try {
    status = await Api.getSignatureStatus(latest.id);
  } catch {
    status = null;
  }
  renderSignatureCard(latest, status);
}

function renderSignatureCard(version, status) {
  const stepper = document.getElementById("stepper");
  const signerList = document.getElementById("signer-list");
  const actions = document.getElementById("sig-actions");
  const sub = document.getElementById("sig-sub");

  const currentIdx = status ? SIG_STEPS.indexOf(status.status) : -1;
  stepper.innerHTML = SIG_STEPS.map((s, i) => `
    <div class="step ${i <= currentIdx ? "done" : ""}">
      <div class="s-dot">${i + 1}</div>
      <div class="s-label">${s[0].toUpperCase() + s.slice(1)}</div>
    </div>`).join("");

  if (!status) {
    sub.textContent = `Send v${versionLabel(version.id)} out for signature to start tracking status.`;
    signerList.innerHTML = "";
    actions.innerHTML = `<button class="btn btn-primary btn-sm" id="send-sig-btn">Send for e-signature</button>`;
    document.getElementById("send-sig-btn").addEventListener("click", async () => {
      try {
        await Api.createSignatureRequest(matterId, version.id, "mock");
        loadSignatureCard();
      } catch (err) {
        alert(`Couldn't send for signature: ${err.message}`);
      }
    });
    return;
  }

  sub.textContent = `Provider: ${status.provider}`;
  signerList.innerHTML = participants
    .map(
      (p) => `<div class="signer-row">
        <div class="avatar" style="width:20px;height:20px;font-size:10px;">${Auth.initials(
          p.user_id === me?.id ? "You" : p.full_name || "?"
        )}</div>
        ${escapeHtml(p.user_id === me?.id ? "You" : p.full_name || "Counterparty")}
        <span class="status-pill ${statusPillClass(status.status)}">${status.status}</span>
      </div>`
    )
    .join("");

  const nextIdx = currentIdx + 1;
  const buttons = [];
  if (nextIdx < SIG_STEPS.length) {
    buttons.push(
      `<button class="btn btn-primary btn-sm" id="advance-sig-btn">Mark as ${SIG_STEPS[nextIdx]}</button>`
    );
  }
  if (status.status !== "declined" && currentIdx < SIG_STEPS.length - 1) {
    buttons.push(`<button class="btn btn-secondary btn-sm" id="resend-sig-btn">Resend reminder</button>`);
  }
  actions.innerHTML = buttons.join("");

  document.getElementById("advance-sig-btn")?.addEventListener("click", async () => {
    try {
      await Api.updateSignatureStatus(status.id, SIG_STEPS[nextIdx]);
      loadSignatureCard();
    } catch (err) {
      alert(`Couldn't update status: ${err.message}`);
    }
  });
  document.getElementById("resend-sig-btn")?.addEventListener("click", () => {
    alert("Reminder resent (demo — no email backend wired up yet).");
  });
}

function statusPillClass(status) {
  if (status === "completed" || status === "signed") return "status-executed";
  if (status === "declined") return "status-awaiting";
  return "status-your-turn";
}

init();
