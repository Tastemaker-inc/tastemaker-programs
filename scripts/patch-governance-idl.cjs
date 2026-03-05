/**
 * Patches target/idl/governance.json:
 * 1. create_proposal "proposal" account gets a "pda" block so the Anchor TS client
 *    auto-derives the proposal address from instruction args (project_key, milestone_index, attempt).
 * 2. If finalize_proposal references RightsType but it is not in governance's types array
 *    (Anchor omits types from external crates), merge RightsType from target/idl/rwa_token.json
 *    so the TS client can serialize the instruction without "Type not found: rightsType?".
 * Run after anchor build (e.g. at start of test script).
 */
const fs = require("fs");
const path = require("path");

const targetDir = path.join(__dirname, "..", "target", "idl");
const idlPath = path.join(targetDir, "governance.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

// --- Patch 1: proposal account PDA seeds for create_proposal ---
const createProposal = idl.instructions.find((ix) => ix.name === "create_proposal");
if (!createProposal) {
  console.error("create_proposal instruction not found");
  process.exit(1);
}

const proposalAccount = createProposal.accounts.find((a) => a.name === "proposal");
if (!proposalAccount) {
  console.error("proposal account not found");
  process.exit(1);
}

const proposalBytes = [112, 114, 111, 112, 111, 115, 97, 108];
proposalAccount.pda = {
  seeds: [
    { kind: "const", value: proposalBytes },
    { kind: "arg", path: "project_key" },
    { kind: "arg", path: "milestone_index" },
    { kind: "arg", path: "attempt" },
  ],
};

// --- Patch 2: merge RightsType from rwa_token if governance references it but doesn't define it ---
function referencesRightsType(idlObj) {
  const instructions = idlObj.instructions || [];
  for (const ix of instructions) {
    const args = ix.args || [];
    for (const arg of args) {
      const name = arg.type?.defined?.name;
      if (name === "RightsType") return true;
    }
  }
  return false;
}

function hasRightsTypeDefinition(idlObj) {
  const types = idlObj.types || [];
  return types.some((t) => t.name === "RightsType");
}

if (referencesRightsType(idl) && !hasRightsTypeDefinition(idl)) {
  const rwaPath = path.join(targetDir, "rwa_token.json");
  if (!fs.existsSync(rwaPath)) {
    console.warn("patch-governance-idl: rwa_token.json not found; skipping RightsType merge. Run anchor build first.");
  } else {
    const rwaIdl = JSON.parse(fs.readFileSync(rwaPath, "utf8"));
    const rightsTypeEntry = (rwaIdl.types || []).find((t) => t.name === "RightsType");
    if (rightsTypeEntry) {
      if (!idl.types) idl.types = [];
      idl.types.push(rightsTypeEntry);
      console.log("Patched governance IDL: merged RightsType from rwa_token (fixes TS client 'Type not found')");
    } else {
      console.warn("patch-governance-idl: RightsType not found in rwa_token.json");
    }
  }
}

fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2));
console.log("Patched governance IDL: proposal account now has pda seeds");
