/* ============================================================
   CLAUSE STANDARDS AND THE AI REVIEW
   ============================================================ */

var clauseLibrary = [];

function runPlaybookReview(contract) {
  // FIXME: the review still ignores annexes on scanned uploads
  return api("ai/playbook", { text: contract.redlineText, standards: clauseLibrary });
}

function playbookDeviations(rows) {
  return rows.filter(function (r) { return r.deviates; });
}

Object.assign(window, { clauseLibrary, runPlaybookReview, playbookDeviations });
