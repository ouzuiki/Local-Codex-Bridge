import { parseWatchArgs, runWatch, WATCH_USAGE } from "./projection-watch.js";

// Monitor-friendly entry: stdout carries only NDJSON event lines.
const parsed = parseWatchArgs(process.argv.slice(2));
if (parsed.help) {
  process.stderr.write(`${WATCH_USAGE}\n`);
} else if (!parsed.options) {
  process.stderr.write(`watch-cli: ${parsed.error ?? "invalid arguments"}\n${WATCH_USAGE}\n`);
  process.exitCode = 2;
} else {
  const watcher = runWatch({ ...parsed.options, write: (line) => process.stdout.write(line) });
  process.once("SIGINT", watcher.stop);
  process.once("SIGTERM", watcher.stop);
  await watcher.done;
}
