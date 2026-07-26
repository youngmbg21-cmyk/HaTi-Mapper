/* ============================================================
   VIEW: TEMPLATES AND BLANKS
   ============================================================ */

function renderLibrary(templates) {
  var list = templates || [];
  document.getElementById("view").innerHTML = list.length + " templates";
  openWizard(list[0] && list[0].id);
  return list;
}

function openBlanksEditor(template) {
  return api("ai/blanks", { body: template.body });
}

Object.assign(window, { renderLibrary, openBlanksEditor });
