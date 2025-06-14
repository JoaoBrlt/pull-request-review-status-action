/** @type {import("npm-check-updates").RunOptions} */
module.exports = {
  // Ignore some package upgrades
  reject: [
    // Node
    // Reason: The Node types need to match the current Node version.
    "@types/node",
  ],
};
