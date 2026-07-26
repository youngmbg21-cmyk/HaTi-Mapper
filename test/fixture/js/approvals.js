/* ============================================================
   THE APPROVAL GATE AND SIGNING ORDER
   ============================================================ */

var approvalRules = [];

function buildApprovalChain(contract) {
  return approvalRules.filter(function (r) { return contract.value >= r.threshold; });
}

function signerPlan(contract) {
  return (contract.signers || []).slice().sort(function (a, b) { return a.order - b.order; });
}

Object.assign(window, { approvalRules, buildApprovalChain, signerPlan });
