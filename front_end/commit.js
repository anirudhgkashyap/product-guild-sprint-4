Auth.requireAuth();
renderSidebar("active");

const matterId = qs("matter_id");
const parentVersionId = qs("parent_version_id");
if (!matterId) window.location.href = "dashboard.html";

let selectedFile = null;

async function init() {
  try {
    const matter = await Api.getMatter(matterId);
    document.getElementById("crumb-matter").textContent = matter.title;
    document.getElementById("crumb-matter").href = `matter.html?matter_id=${matterId}`;
    document.getElementById("cancel-btn").addEventListener("click", () => {
      window.location.href = `matter.html?matter_id=${matterId}`;
    });
  } catch (err) {
    document.getElementById("branch-box").textContent = `Couldn't load matter: ${err.message}`;
    return;
  }

  const branchBox = document.getElementById("branch-box");
  if (parentVersionId) {
    try {
      const v = await Api.getVersion(parentVersionId);
      const versions = await Api.listVersions(matterId);
      const num = versions.findIndex((x) => x.id === v.id) + 1;
      branchBox.innerHTML = `<span class="doc-ic"></span> v${num} — committed ${timeAgo(v.created_at)}`;
    } catch {
      branchBox.innerHTML = `<span class="doc-ic"></span> Branching from the latest version`;
    }
  } else {
    branchBox.innerHTML = `<span class="doc-ic"></span> First version for this matter`;
  }
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const browseLink = document.getElementById("browse-link");
const submitBtn = document.getElementById("commit-submit");

browseLink.addEventListener("click", (e) => {
  e.preventDefault();
  fileInput.click();
});
dropzone.addEventListener("click", (e) => {
  if (e.target === browseLink) return;
  fileInput.click();
});
["dragover", "dragenter"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "dragend", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, () => dropzone.classList.remove("dragover"))
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

function setFile(file) {
  if (!file.name.toLowerCase().endsWith(".docx")) {
    alert("Please upload a .docx file.");
    return;
  }
  selectedFile = file;
  dropzone.classList.add("has-file");
  dropzone.innerHTML = `<div class="file-chip">✓ ${escapeHtml(file.name)}</div><div class="dz-sub">Click to choose a different file.</div>`;
  submitBtn.disabled = false;
}

document.getElementById("notify-toggle").addEventListener("change", (e) => {
  document.getElementById("notify-sub").textContent = e.target.checked
    ? "They'll get an email + in-app alert."
    : "They won't be notified until they check back.";
});

document.getElementById("commit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedFile) return;
  const errEl = document.getElementById("commit-error");
  errEl.style.display = "none";
  submitBtn.disabled = true;
  submitBtn.textContent = "Committing…";

  try {
    const formData = new FormData();
    formData.append("matter_id", matterId);
    formData.append("commit_message", document.getElementById("commit-message").value.trim());
    if (parentVersionId) formData.append("parent_version_id", parentVersionId);
    formData.append("file", selectedFile);
    await Api.commitVersion(formData);
    // Note: "notify counterparty" has no email/notification backend yet —
    // the commit itself is already visible to them the moment RLS lets
    // them read it; this toggle is a placeholder for that future feature.
    window.location.href = `matter.html?matter_id=${matterId}`;
  } catch (err) {
    errEl.textContent = err.message || "Couldn't commit this version.";
    errEl.style.display = "block";
    submitBtn.disabled = false;
    submitBtn.textContent = "Commit Version →";
  }
});

init();
