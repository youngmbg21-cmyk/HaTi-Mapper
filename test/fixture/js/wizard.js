/* ============================================================
   STARTING A CONTRACT FROM A TEMPLATE
   ============================================================ */

function openWizard(templateId) {
  return api("ai/template", { templateId: templateId });
}

Object.assign(window, { openWizard });
