/* ============================================================
   CORE: HASHING, FREEZING AND THE AUDIT TRAIL
   ============================================================ */

function sealString(contract) {
  return [contract.id, contract.expiry, contract.redlineText].join("|");
}

function canonicalDoc(html) {
  return String(html || "").replace(/\s+/g, " ").trim();
}

function freezeContractHtml(contract) {
  return canonicalDoc(contract.docBodyHtml);
}

function logAudit(contractId, what) {
  return api("audit", { contractId: contractId, what: what });
}

Object.assign(window, { sealString, canonicalDoc, freezeContractHtml, logAudit });
