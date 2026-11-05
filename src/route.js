// Decides which engine gets the command line. Only --browser belongs to the
// umbrella; every other argument goes to the engine untouched.

const ENGINES = { safari: "aqueduct", firefox: "lavaduct" };

const VALUE = "--browser takes safari or firefox.";
const ONCE = "--browser can only be given once.";
const MACOS = "Safari conversion needs macOS. Use --browser firefox to convert for Firefox.";
const MIN_FIREFOX_NODE = [22, 13];

export const BROWSER_HELP =
  "\nBROWSER\n" +
  "      --browser <name>      safari (default) or firefox. Safari needs macOS.\n" +
  "                            Every other option goes to that browser's engine:\n" +
  "                            aqueduct for Safari, lavaduct for Firefox.\n";

const usage = (message) => ({ ok: false, message, exitCode: 2 });

function nodeAtLeast(version, [major, minor]) {
  const [maj, min] = version.split(".").map(Number);
  return maj > major || (maj === major && min >= minor);
}

export function route(argv, env) {
  const args = [];
  let browser;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      args.push(...argv.slice(i));
      break;
    }
    let value;
    if (arg === "--browser") {
      value = argv[++i];
    } else if (arg.startsWith("--browser=")) {
      value = arg.slice("--browser=".length);
    } else {
      if (arg === "-h" || arg === "--help") help = true;
      args.push(arg);
      continue;
    }
    if (browser !== undefined) return usage(ONCE);
    if (value === undefined || value.startsWith("-") || !Object.hasOwn(ENGINES, value)) return usage(VALUE);
    browser = value;
  }

  browser ??= "safari";
  if (browser === "safari" && env.platform !== "darwin") return usage(MACOS);
  if (browser === "firefox" && !nodeAtLeast(env.nodeVersion, MIN_FIREFOX_NODE)) {
    return {
      ok: false,
      message: `Firefox conversion needs Node.js 22.13 or newer. This is Node.js ${env.nodeVersion}.`,
      exitCode: 1,
    };
  }
  return { ok: true, engine: ENGINES[browser], args, help };
}
