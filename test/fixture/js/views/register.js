/* ============================================================
   VIEW: THE REGISTER TABLE
   ============================================================ */

function renderRegister(contracts) {
  var rows = (contracts || []).map(function (c) { return c.counterparty + " " + c.expiry; });
  document.getElementById("view").innerHTML = rows.join("");
  return api("search", { q: window.registerQuery || "" });
}

Object.assign(window, { renderRegister });
