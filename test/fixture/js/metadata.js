/* ============================================================
   PULLING DETAILS OUT OF A DOCUMENT
   ============================================================ */

function extractMetadata(contract) {
  return api("ai/extract", { text: contract.redlineText, want: ["counterparty", "expiry"] });
}

function applyMetadata(contract, meta) {
  contract.counterparty = meta.counterparty;
  contract.expiry = meta.expiry;
  return contract;
}

Object.assign(window, { extractMetadata, applyMetadata });
