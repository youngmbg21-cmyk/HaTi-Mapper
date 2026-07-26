/* ============================================================
   CAPTURING THE MARK
   ============================================================ */

function openSignaturePad(contract) {
  document.getElementById("view").innerHTML = "<canvas id=\"pad\"></canvas>";
  return contract.id;
}

Object.assign(window, { openSignaturePad });
