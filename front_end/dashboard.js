Auth.requireAuth();
renderSidebar("active");

const me = Auth.getUser();
let allRows = []; // enriched matter rows
let currentFilter = "all";

async function loadDashboard() {
  const tbody = document.getElementById("matters-tbody");
  try {
    const matters = await Api.listMatters();
    if (matters.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <h3>No negotiations yet</h3>
        <p>Start your first matter to see it here.</p>
      </div></td></tr>`;
      updateCounts([]);
      return;
    }

    // Enrich each matter with its latest version + counterparty, in parallel.
    allRows = await Promise.all(
      matters.map(async (m) => {
        const [versions, participants] = await Promise.all([
          Api.listVersions(m.id).catch(() => []),
          Db.getParticipants(m.id).catch(() => []),
        ]);
        const latest = versions[versions.length - 1] || null;
        const counterparty = participants.find((p) => p.user_id !== me?.id) || null;

        let turnStatus = "awaiting"; // default: waiting on the other side
        if (!latest) {
          turnStatus = "your-turn"; // nothing committed yet — someone needs to start
        } else if (latest.committed_by === me?.id) {
          turnStatus = "awaiting"; // we committed last, ball's in their court
        } else {
          turnStatus = "your-turn"; // they committed last, we need to respond
        }

        return { matter: m, versions, latest, counterparty, turnStatus };
      })
    );

    renderRows();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <h3>Couldn't load negotiations</h3>
      <p>${escapeHtml(err.message)}</p>
    </div></td></tr>`;
  }
}

function updateCounts(rows) {
  document.getElementById("count-all").textContent = `(${rows.length})`;
  document.getElementById("count-your-turn").textContent =
    `(${rows.filter((r) => r.turnStatus === "your-turn").length})`;
  document.getElementById("count-awaiting").textContent =
    `(${rows.filter((r) => r.turnStatus === "awaiting").length})`;
}

function statusPill(row) {
  if (row.matter.status === "executed") return `<span class="status-pill status-executed">Signed</span>`;
  if (row.matter.status === "archived") return `<span class="status-pill status-archived">Archived</span>`;
  if (row.turnStatus === "your-turn") return `<span class="status-pill status-your-turn">Your turn</span>`;
  return `<span class="status-pill status-awaiting">Awaiting counterparty</span>`;
}

function renderRows() {
  const search = document.getElementById("search-input").value.trim().toLowerCase();
  let rows = allRows;
  if (currentFilter !== "all") rows = rows.filter((r) => r.turnStatus === currentFilter);
  if (search) {
    rows = rows.filter((r) => {
      const hay = `${r.matter.title} ${r.counterparty?.full_name || ""}`.toLowerCase();
      return hay.includes(search);
    });
  }
  updateCounts(allRows);

  const tbody = document.getElementById("matters-tbody");
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <h3>No matches</h3><p>Try a different search or tab.</p>
    </div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const m = r.matter;
      const versionMeta = r.versions.length
        ? `v${r.versions.length} · ${r.latest?.commit_message ? escapeHtml(r.latest.commit_message).slice(0, 42) : "no message"}`
        : "No versions yet";
      const counterpartyName = r.counterparty?.full_name || (r.counterparty ? "Counterparty" : "Not yet invited");
      const lastActivity = timeAgo(r.latest?.created_at || m.updated_at);
      const lastActor = r.latest
        ? r.latest.committed_by === me?.id
          ? "You"
          : r.counterparty?.full_name || "Counterparty"
        : "—";

      return `
        <tr class="row-link" data-matter-id="${m.id}">
          <td><button class="star-btn" title="Star" onclick="event.stopPropagation()">★</button></td>
          <td class="matter-cell">
            <div class="title">${escapeHtml(m.title)}</div>
            <div class="meta">${versionMeta}</div>
          </td>
          <td>
            <div class="counterparty-cell">
              <div class="avatar" style="width:22px;height:22px;font-size:10px;">${Auth.initials(counterpartyName)}</div>
              ${escapeHtml(counterpartyName)}
            </div>
          </td>
          <td>${statusPill(r)}</td>
          <td>${lastActivity}</td>
          <td>${escapeHtml(lastActor)}</td>
          <td><button class="kebab-btn" onclick="event.stopPropagation()">⋮</button></td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("tr.row-link").forEach((tr) => {
    tr.addEventListener("click", () => {
      window.location.href = `matter.html?matter_id=${tr.dataset.matterId}`;
    });
  });
}

document.getElementById("search-input").addEventListener("input", renderRows);
document.querySelectorAll("#tabbar .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#tabbar .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.filter;
    renderRows();
  });
});

/* -------- new negotiation modal -------- */
const modal = document.getElementById("new-modal");
document.getElementById("new-negotiation-btn").addEventListener("click", () => (modal.style.display = "flex"));
document.getElementById("new-matter-cancel").addEventListener("click", () => (modal.style.display = "none"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.style.display = "none";
});

document.getElementById("new-matter-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("new-matter-error");
  const btn = document.getElementById("new-matter-submit");
  errEl.style.display = "none";
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const title = document.getElementById("nm-title").value.trim();
    const description = document.getElementById("nm-desc").value.trim() || null;
    const counterpartyId = document.getElementById("nm-counterparty-id").value.trim();
    const matter = await Api.createMatter(title, description);
    if (counterpartyId) {
      await Api.addParticipant(matter.id, counterpartyId, "counterparty").catch((err) => {
        console.warn("Couldn't add counterparty yet:", err.message);
      });
    }
    window.location.href = `matter.html?matter_id=${matter.id}`;
  } catch (err) {
    errEl.textContent = err.message || "Couldn't create that negotiation.";
    errEl.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Create negotiation";
  }
});

loadDashboard();
