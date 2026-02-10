/**
 * Patches target/idl/governance.json so the create_proposal "proposal" account
 * has a "pda" block. The Anchor TS client then auto-derives the proposal address
 * from instruction args (project_key, milestone_index, attempt), matching the program.
 * Run after anchor build (e.g. at start of test script).
 */
const fs = require("fs");
const path = require("path");

const idlPath = path.join(__dirname, "..", "target", "idl", "governance.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

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

// "proposal" as bytes
const proposalBytes = [112, 114, 111, 112, 111, 115, 97, 108];
proposalAccount.pda = {
  seeds: [
    { kind: "const", value: proposalBytes },
    { kind: "arg", path: "project_key" },
    { kind: "arg", path: "milestone_index" },
    { kind: "arg", path: "attempt" },
  ],
};

fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2));
console.log("Patched governance IDL: proposal account now has pda seeds");
