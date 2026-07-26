/* ============================================================
   READING TEXT OFF A SCANNED PAGE
   ============================================================ */

function ocrDocument(dataUrl) {
  return api("ai/ocr", { dataUrl: dataUrl });
}

Object.assign(window, { ocrDocument });
