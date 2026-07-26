/* ============================================================
   VIEW: TEAM, ROLES AND CAPS
   ============================================================ */

function renderSettings(settings) {
  var s = settings || {};
  document.getElementById("view").innerHTML = JSON.stringify(s.approvalRules || approvalRules);
  return s;
}

Object.assign(window, { renderSettings });
