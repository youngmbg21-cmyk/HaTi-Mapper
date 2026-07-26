/* ============================================================
   VIEW: HOME AND THE ATTENTION LIST
   ============================================================ */

function renderDashboard(contracts) {
  var rows = contracts || [];
  document.getElementById("view").innerHTML = kpiTiles(rows);
  return rows;
}

function kpiTiles(rows) {
  return "<div>" + rows.length + " contracts</div>";
}

Object.assign(window, { renderDashboard, kpiTiles });
