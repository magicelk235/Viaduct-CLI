export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  category: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
  autoFixed?: boolean;
  /** The runtime shim emulates this call, so it won't throw — flagged so the
   * report can reassure rather than alarm the author. */
  shimmed?: boolean;
}

export interface Manifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  version_name?: string;
  description?: string;
  background?: {
    service_worker?: string;
    scripts?: string[];
    page?: string;
    persistent?: boolean;
    type?: string;
  };
  action?: Record<string, unknown> & { default_popup?: string };
  browser_action?: Record<string, unknown> & { default_popup?: string };
  page_action?: Record<string, unknown> & { default_popup?: string };
  side_panel?: Record<string, unknown> & { default_path?: string };
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  content_scripts?: Array<{
    js?: string[];
    css?: string[];
    matches?: string[];
    run_at?: string;
    all_frames?: boolean;
    world?: "MAIN" | "ISOLATED";
  }>;
  web_accessible_resources?: unknown;
  commands?: Record<string, unknown>;
  externally_connectable?: { ids?: string[]; matches?: string[] };
  content_security_policy?: Record<string, string> | string;
  declarative_net_request?: {
    rule_resources?: Array<{ id: string; enabled: boolean; path: string }>;
  };
  update_url?: string;
  key?: string;
  minimum_chrome_version?: string;
  browser_specific_settings?: Record<string, unknown>;
  default_locale?: string;
  icons?: Record<string, string>;
  incognito?: string;
  chrome_url_overrides?: Record<string, string>;
  devtools_page?: string;
  options_page?: string;
  options_ui?: { page?: string };
  sandbox?: { pages?: string[] };
  [key: string]: unknown;
}

export type Platforms = "all" | "macos" | "ios";

export interface ConvertOptions {
  input: string;
  output?: string;
  bundleId?: string;
  appName?: string;
  platforms: Platforms;
  /** symlink source into the Xcode project (dev) vs copy (CI/clean) */
  copyResources: boolean;
  tempLoadOnly: boolean;
  generateShim: boolean;
  build: boolean;
  force: boolean;
  /** Treat warnings as blocking (CI gate); --force still overrides. */
  strict?: boolean;
  /** Wipe the output dir before staging (drop stale leftovers). */
  clean?: boolean;
  /** Also emit a distributable .zip of the staged extension. */
  zip?: boolean;
  /** Open the generated .xcodeproj in Xcode when done. */
  openXcode?: boolean;
  /** Safari strict_min_version for browser_specific_settings (default: DEFAULT_MIN_SAFARI_VERSION in manifest.ts). */
  minSafariVersion?: string;
  keepModuleBackground: boolean;
  /** Wire the Safari OAuth/externally_connectable bridge (default on). */
  oauthBridge?: boolean;
  /** Copy the built app into ~/Applications and register it with Safari. */
  install: boolean;
  /** Override the install target dir (default ~/Applications). */
  installDir?: string;
  /** During --install, quit/relaunch Safari and write the unsigned toggle. */
  safariRestart: boolean;
  /** Apple Developer Team ID to sign with (real signing → persists across Safari quits). */
  team?: string;
  verbose: boolean;
}

export interface ConvertResult {
  success: boolean;
  extensionName: string;
  manifestVersion: number;
  issues: Issue[];
  stagedPath?: string;
  zipPath?: string;
  xcodeProject?: string;
  appPath?: string;
  resolvedBundleId?: string;
  installedAppPath?: string;
}
