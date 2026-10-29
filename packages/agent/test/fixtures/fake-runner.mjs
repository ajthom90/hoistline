// Test fixture: a stand-in runner CLI. Prints its argv (after the script path) and everything it read on stdin as
// one JSON object, so tests can check that a value reached the child unchanged.
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));
});
