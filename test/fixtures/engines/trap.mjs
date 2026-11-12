// Stands in for aqueduct's own signal handler, which exits 130.
process.on("SIGTERM", () => {
  process.stdout.write("term\n", () => process.exit(130));
});
process.stderr.write(`pid ${process.pid}\n`);
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
