/* ============================================================
   VIEW: THE LEGAL SERVICES PIPELINE
   ============================================================ */

function renderAdvice(requests) {
  var list = requests || [];
  document.getElementById("view").innerHTML = list.length + " requests";
  return list;
}

Object.assign(window, { renderAdvice });
