/* HaTi front end - routing and boot. */

function api(path, body) {
  return fetch("api/" + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) { return r.json(); });
}

function setView(view) {
  if (view === "dashboard") renderDashboard();
  else if (view === "register") renderRegister();
  else if (view === "calendar") renderCalendar();
  else if (view === "intel") renderIntelligence();
  else if (view === "templates") renderLibrary();
  else if (view === "team") renderSettings();
  else if (view === "playbook") renderPlaybook();
  else if (view === "advice") renderAdvice();
  else if (view === "migration") renderMigration();
  else renderWorkspace();
}

function renderResetScreen(token) {
  document.getElementById("view").innerHTML = "<h1>Choose a new password</h1>";
  window.resetToken = token;
}

function readStatus(r) { return r.json(); }

function start(status) {
  window.session = status;
  setView(status.lastView || "dashboard");
}

function boot() {
  var share = location.hash.match(/^#share=(.+)$/);
  if (share) return portalEntry(share[1]);
  var advice = location.hash.match(/^#advice=(.+)$/);
  if (advice) return adviceEntry(advice[1]);
  var reset = location.hash.match(/^#reset=(.+)$/);
  if (reset) return renderResetScreen(reset[1]);
  fetch("api/status").then(readStatus).then(start);
}

document.querySelectorAll(".nav-item").forEach(function (b) {
  b.addEventListener("click", function () { setView(b.getAttribute("data-view")); });
});

boot();

Object.assign(window, { api, setView, boot, renderResetScreen, readStatus, start });
