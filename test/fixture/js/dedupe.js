/* ============================================================
   DUPLICATE DETECTION ON IMPORT
   ============================================================ */

function simhash64(text) {
  var h = 0;
  for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 1000000007;
  return h;
}

function isDuplicate(fileHash, seen) {
  return seen.indexOf(fileHash) > -1;
}

Object.assign(window, { simhash64, isDuplicate });
