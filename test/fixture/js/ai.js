/* ============================================================
   THE COPILOT
   ============================================================ */

function copilotAsk(question) {
  return api("ai/chat", { question: question });
}

function copilotReset() {
  window.copilotHistory = [];
}

Object.assign(window, { copilotAsk, copilotReset });
