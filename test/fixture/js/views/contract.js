/* ============================================================
   VIEW: READING AND EDITING THE DOCUMENT
   ============================================================ */

function renderWorkspace(contract) {
  var c = contract || {};
  c.docBodyHtml = c.docBodyHtml || "";
  document.getElementById("view").innerHTML = freezeContractHtml(c);
  extractMetadata(c);
  runPlaybookReview(c);
  renderObligationsSection(c);
  captureVersion(c);
  logAudit(c.id, "opened");
  return c;
}

function docBodyHtml(contract) { return contract.redlineText; }

/* ============================================================
   EDITING, COMMENTS AND SHARING
   ============================================================ */

function openEditDocModal(contract) {
  openCompareModal(contract.redlineText, contract.redlineText);
  openSignaturePad(contract);
  return sealString(contract);
}

function addComment(contract, text) {
  contract.comments = (contract.comments || []).concat([{ text: text }]);
  return contract.comments;
}

function shareContract(contract) {
  return api("share", { id: contract.id, shares: contract.shares || [] });
}

Object.assign(window, { renderWorkspace, docBodyHtml, openEditDocModal, addComment, shareContract });
