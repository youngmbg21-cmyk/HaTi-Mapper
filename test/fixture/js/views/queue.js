/* ============================================================
   VIEW: THE PIPELINE BOARD
   ============================================================ */

function renderPipeline(contracts) {
  var stages = ["draft", "review", "signing", "signed"];
  document.getElementById("view").innerHTML = stages.join("");
  return buildApprovalChain({ value: 0 }) && contracts;
}

Object.assign(window, { renderPipeline });
