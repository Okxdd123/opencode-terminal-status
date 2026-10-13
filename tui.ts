// Discovery shim: local directory discovery only resolves a top-level
// `tui.ts`. Re-export the source so git-clone installs always run fresh
// code with no build step. (The npm flow uses package.json exports.)
export { default } from "./src/tui"
