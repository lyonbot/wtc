// Bun `with { type: "file" }` imports resolve to a path string (embedded when compiled).
declare module "*/wtc-entry" { const path: string; export default path; }
declare module "*/wtc-signal" { const path: string; export default path; }
declare module "*/wtc-install" { const path: string; export default path; }
declare module "*/wtc-remark" { const path: string; export default path; }
declare module "*/wtc-kit" { const path: string; export default path; }
