// Re-export from src/ so the package root can be the extension entry point.
// This lets PI derive the label "pi-subagents" instead of "src".
export { default } from "./src/index.js";
