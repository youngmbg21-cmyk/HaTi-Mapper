/* ============================================================
   VIEW: THE CONTRACT GRAPH
   ============================================================ */

function renderIntelligence() {
  document.getElementById("view").innerHTML = "<svg id=\"graph\"></svg>";
  return buildGraphModel([]);
}

function buildGraphModel(contracts) {
  return api("ai/graph", { ids: contracts.map(function (c) { return c.id; }) });
}

function riskScore(contract) {
  return (contract.value || 0) / 1000;
}

function scanPortfolio(contracts) {
  return contracts.length;
}

Object.assign(window, { renderIntelligence, buildGraphModel, riskScore, scanPortfolio });
