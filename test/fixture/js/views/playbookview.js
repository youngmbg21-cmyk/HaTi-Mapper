/* ============================================================
   VIEW: THE CLAUSE LIBRARY SCREEN
   ============================================================ */

function renderPlaybook() {
  document.getElementById("view").innerHTML = clauseLibrary.length + " clauses";
  return playbookDeviations([]);
}

Object.assign(window, { renderPlaybook });
