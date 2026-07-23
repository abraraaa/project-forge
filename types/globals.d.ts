// Ambient declarations for the checkJs pass (audit #63). Next's bundler
// understands side-effect CSS imports; tsc needs to be told they exist.
declare module "*.css";
