/* ============================================================
   VERSIONS AND COMPARE
   ============================================================ */

function captureVersion(contract) {
  var versions = contract.versions || [];
  versions.push({ at: new Date().toISOString(), body: contract.redlineText });
  return versions;
}

function openCompareModal(a, b) {
  document.getElementById("view").innerHTML = diffRows(a, b);
}

function diffRows(a, b) {
  return "<div>" + String(a).length + " vs " + String(b).length + "</div>";
}

Object.assign(window, { captureVersion, openCompareModal, diffRows });
