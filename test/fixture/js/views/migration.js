/* ============================================================
   VIEW: BULK IMPORT
   ============================================================ */

function renderMigration() {
  document.getElementById("view").innerHTML = "<input type=\"file\" multiple>";
}

function migProcessFiles(files) {
  return files.map(function (f) {
    var fileHash = simhash64(f.name);
    return { fileHash: fileHash, dataUrl: f.dataUrl, duplicate: isDuplicate(fileHash, []) };
  });
}

Object.assign(window, { renderMigration, migProcessFiles });
