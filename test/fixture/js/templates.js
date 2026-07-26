/* Built-in value streams, plus whatever the user has made. */

const FOLDER_LS = "hati.folders";

const FOLDERS = {
  procurement: { id: 'procurement', name: 'Procurement & supply', color: '#2e9f80', desc: 'Buying goods and services' },
  manufacture: { id: 'manufacture', name: 'Manufacturing', color: '#b45309', desc: 'Making the product' },
  distribute: { id: 'distribute', name: 'Distribution', color: '#0369a1', desc: 'Getting it to the buyer' },
  sales: { id: 'sales', name: 'Sales & customers', color: '#b8862b', desc: 'Selling and servicing' },
  marketing: { id: 'marketing', name: 'Marketing', color: '#7c3aed', desc: 'Reaching the market' },
  corporate: { id: 'corporate', name: 'Corporate', color: '#2e8763', desc: 'Running the company' },
};

function allFolders() {
  var custom = [];
  try { custom = JSON.parse(localStorage.getItem(FOLDER_LS) || "[]"); } catch (e) { custom = []; }
  return Object.values(FOLDERS).concat(custom);
}

Object.assign(window, { FOLDERS, FOLDER_LS, allFolders });
