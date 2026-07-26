/* ============================================================
   VIEW: RENEWALS AND DEADLINES
   ============================================================ */

function renderCalendar(contracts) {
  var dates = (contracts || []).map(function (c) { return effectiveExpiry(c, []); });
  document.getElementById("view").innerHTML = dates.join("");
  return dates;
}

Object.assign(window, { renderCalendar });
