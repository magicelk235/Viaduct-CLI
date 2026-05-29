export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  category: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
  autoFixed?: boolean;
}

export interface Manifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  description?: string;
  background?: {
    service_worker?: string;
    scripts?: string[];
    persistent?: boolean;
    type?: string;
  };
  action?: Record<string, unknown> & { default_popup?: string };
  browser_action?: Record<string, unknown> & { default_popup?: string };
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  content_scripts?: Array<{
    js?: string[];
    css?: string[];
    matches?: string[];
    run_at?: string;
    all_frames?: boolean;
  }>;
  web_accessible_resources?: unknown;
  commands?: Record<string, unknown>;
  externally_connectable?: { ids?: string[]; matches?: string[] };
  content_security_policy?: Record<string, string> | string;
  update_url?: string;
  key?: string;
  minimum_chrome_version?: string;
  browser_specific_settings?: Record<string, unknown>;
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
  keepModuleBackground: boolean;
  verbose: boolean;
}

export interface ConvertResult {
  success: boolean;
  extensionName: string;
  manifestVersion: number;
  issues: Issue[];
  stagedPath?: string;
  xcodeProject?: string;
  appPath?: string;
  resolvedBundleId?: string;
}
