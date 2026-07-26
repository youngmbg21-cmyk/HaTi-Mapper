/* ============================================================
   VIEW: WHAT THE COUNTERPARTY SEES
   ============================================================ */

function portalEntry(token) {
  // TODO: show the evidence pack link once the export is signed off
  return api("share/" + token).then(function (contract) {
    document.getElementById("view").innerHTML = freezeContractHtml(contract);
    return contract;
  });
}

function exportPDF(contract) {
  return api("export/" + contract.id);
}

Object.assign(window, { portalEntry, exportPDF });
