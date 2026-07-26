/* ============================================================
   PAYMENT DATES AND NOTICE DEADLINES
   ============================================================ */

function renderObligationsSection(contract) {
  return api("ai/obligations", { text: contract.redlineText }).then(function (obligations) {
    document.getElementById("view").innerHTML = obligations.length + " obligations";
    return obligations;
  });
}

function overdueObligationCount(obligations) {
  return obligations.filter(function (o) { return o.due < Date.now(); }).length;
}

Object.assign(window, { renderObligationsSection, overdueObligationCount });
