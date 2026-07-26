/* ============================================================
   VIEW: PORTFOLIO REPORTING
   ============================================================ */

function renderReports() {
  document.getElementById("view").innerHTML = JSON.stringify(computeReports([]));
}

function computeReports(contracts) {
  return { total: contracts.length, byStream: allFolders().length };
}

Object.assign(window, { renderReports, computeReports });
