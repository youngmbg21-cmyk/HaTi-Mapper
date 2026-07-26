/* ============================================================
   AMENDMENTS AND THE CONTRACT FAMILY
   ============================================================ */

function effectiveExpiry(contract, amendments) {
  return amendments.reduce(function (d, a) { return a.expiry > d ? a.expiry : d; }, contract.expiry);
}

function familyOf(contract, all) {
  return all.filter(function (c) { return c.parentId === contract.id; });
}

function isParent(contract, all) { return familyOf(contract, all).length > 0; }

Object.assign(window, { effectiveExpiry, familyOf, isParent });
