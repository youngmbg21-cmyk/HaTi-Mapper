/* ============================================================
   VIEW: THE PUBLIC ADVICE PORTAL
   ============================================================ */

function adviceEntry(token) {
  return api("advice/rates").then(function (rates) {
    document.getElementById("view").innerHTML = rates.length + " rates";
    return token;
  });
}

Object.assign(window, { adviceEntry });
